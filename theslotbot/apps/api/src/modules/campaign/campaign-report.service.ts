/**
 * src/modules/campaign/campaign-report.service.ts
 *
 * Powers the salon owner's revisit campaign report (Section 8.1:
 * "Monthly count of Day 30/37 messages sent, delivered, read, and
 * converted to bookings — the report that substantiates the Clause
 * 4.1 performance milestone").
 *
 * Uses $queryRaw for month-bucketing because Prisma's query builder
 * has no native date_trunc equivalent — this is the standard escape
 * hatch for this class of aggregation, not a sign of avoiding the ORM
 * unnecessarily. Both queries are parameterized (Prisma's tagged
 * template `$queryRaw` handles this safely; salonId and the date
 * cutoff are never string-interpolated into the SQL).
 *
 * FUNNEL COUNTING LOGIC:
 * MessageLog.status is the message's current (furthest-reached) state,
 * not a set of independent flags — Meta's delivery callbacks only move
 * status forward (sent → delivered → read), never backward, so a
 * message currently at 'read' correctly implies it was also delivered
 * and sent. The pivot below relies on that monotonic-progress
 * assumption: a row with status='read' increments all three funnel
 * stages (sent, delivered, read), not just the read count.
 */

import { prisma } from '@/lib/prisma';
import { CampaignReportRowDto } from '@theslotbot/shared/types';
import { addCalendarDays, todayInSalonTimezone } from '@/lib/timezone';

interface FunnelRow {
  period: string;
  message_type: string;
  status: string;
  count: bigint;
}

interface ConvertedRow {
  period: string;
  converted: bigint;
}

export async function getCampaignReport(
  salonId: string,
  months: number,
): Promise<CampaignReportRowDto[]> {
  const cutoffDateStr = addCalendarDays(todayInSalonTimezone(), -30 * months);
  const cutoff = new Date(`${cutoffDateStr}T00:00:00.000Z`);

  const [funnelRows, convertedRows] = await Promise.all([
    prisma.$queryRaw<FunnelRow[]>`
      SELECT
        to_char(date_trunc('month', sent_at), 'YYYY-MM') as period,
        message_type,
        status,
        count(*)::bigint as count
      FROM message_logs
      WHERE salon_id = ${salonId}
        AND message_type IN ('revisit_day30', 'revisit_day37')
        AND sent_at IS NOT NULL
        AND sent_at >= ${cutoff}
      GROUP BY period, message_type, status
    `,
    // Attribution approximation — see CampaignReportRowDto.converted doc
    // comment in packages/shared/types/index.ts for the caveat.
    prisma.$queryRaw<ConvertedRow[]>`
      SELECT
        to_char(date_trunc('month', ml.sent_at), 'YYYY-MM') as period,
        count(DISTINCT ml.customer_id)::bigint as converted
      FROM message_logs ml
      JOIN customers c ON c.id = ml.customer_id
      WHERE ml.salon_id = ${salonId}
        AND ml.message_type IN ('revisit_day30', 'revisit_day37')
        AND ml.sent_at IS NOT NULL
        AND ml.sent_at >= ${cutoff}
        AND c.revisit_campaign_status = 'converted'
      GROUP BY period
    `,
  ]);

  return pivotToReportRows(funnelRows, convertedRows);
}

function pivotToReportRows(
  funnelRows: FunnelRow[],
  convertedRows: ConvertedRow[],
): CampaignReportRowDto[] {
  const byPeriod = new Map<string, CampaignReportRowDto>();

  const getOrCreate = (period: string): CampaignReportRowDto => {
    let row = byPeriod.get(period);
    if (!row) {
      row = {
        period,
        day30Sent: 0,
        day30Delivered: 0,
        day30Read: 0,
        day37Sent: 0,
        day37Delivered: 0,
        day37Read: 0,
        converted: 0,
      };
      byPeriod.set(period, row);
    }
    return row;
  };

  for (const r of funnelRows) {
    const row = getOrCreate(r.period);
    const count = Number(r.count);
    const isDay30 = r.message_type === 'revisit_day30';

    if (r.status === 'sent' || r.status === 'delivered' || r.status === 'read') {
      if (isDay30) row.day30Sent += count;
      else row.day37Sent += count;
    }
    if (r.status === 'delivered' || r.status === 'read') {
      if (isDay30) row.day30Delivered += count;
      else row.day37Delivered += count;
    }
    if (r.status === 'read') {
      if (isDay30) row.day30Read += count;
      else row.day37Read += count;
    }
  }

  for (const r of convertedRows) {
    const row = getOrCreate(r.period);
    row.converted = Number(r.converted);
  }

  return Array.from(byPeriod.values()).sort((a, b) => b.period.localeCompare(a.period));
}
