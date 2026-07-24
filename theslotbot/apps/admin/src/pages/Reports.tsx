/**
 * src/pages/Reports.tsx
 *
 * Route-level access is already restricted by Layout.tsx (the nav
 * link only renders for salon_owner+), and the backend independently
 * rejects salon_staff regardless of whether they found their way here
 * directly by URL — this page renders assuming access is already
 * validated server-side per request, not because the frontend decided so.
 */

import { useState } from 'react';
import type { CampaignReportRowDto } from '@theslotbot/shared/types';
import { useCampaignReport } from '@/hooks/useReports';

export function Reports() {
  const [months, setMonths] = useState(3);
  const { data: rows, isLoading, error } = useCampaignReport(months);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            Revisit campaign report
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            Day 30 and Day 37 message delivery and conversion, by month.
          </p>
        </div>
        <select
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          className="rounded-md border border-ink-200 px-3 py-1.5 text-sm"
        >
          <option value={3}>Last 3 months</option>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
        </select>
      </header>

      {isLoading && <p className="text-sm text-ink-500">Loading report…</p>}
      {error && (
        <p className="rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
          Couldn't load the campaign report.
        </p>
      )}
      {rows && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-ink-300 bg-white p-6 text-center text-sm text-ink-500">
          No campaign messages sent in this period yet.
        </p>
      )}
      {rows && rows.length > 0 && <ReportTable rows={rows} />}
    </div>
  );
}

function ReportTable({ rows }: { rows: CampaignReportRowDto[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-3 font-medium">Month</th>
            <th className="px-4 py-3 font-medium text-right">Day 30 sent</th>
            <th className="px-4 py-3 font-medium text-right">Delivered</th>
            <th className="px-4 py-3 font-medium text-right">Read</th>
            <th className="px-4 py-3 font-medium text-right">Day 37 sent</th>
            <th className="px-4 py-3 font-medium text-right">Delivered</th>
            <th className="px-4 py-3 font-medium text-right">Read</th>
            <th className="px-4 py-3 font-medium text-right">Converted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.map((row) => (
            <tr key={row.period}>
              <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-900">
                {formatPeriod(row.period)}
              </td>
              <Cell value={row.day30Sent} />
              <Cell value={row.day30Delivered} rate={rate(row.day30Delivered, row.day30Sent)} />
              <Cell value={row.day30Read} rate={rate(row.day30Read, row.day30Delivered)} />
              <Cell value={row.day37Sent} />
              <Cell value={row.day37Delivered} rate={rate(row.day37Delivered, row.day37Sent)} />
              <Cell value={row.day37Read} rate={rate(row.day37Read, row.day37Delivered)} />
              <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-status-completed">
                {row.converted}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
        "Converted" counts customers who received a Day 30 or Day 37 message in that month and
        have since rebooked — an approximation, not an exact same-month conversion count.
      </p>
    </div>
  );
}

function Cell({ value, rate }: { value: number; rate?: number | null }) {
  return (
    <td className="whitespace-nowrap px-4 py-3 text-right text-ink-700">
      {value}
      {rate !== undefined && rate !== null && (
        <span className="ml-1.5 text-xs text-ink-400">({rate}%)</span>
      )}
    </td>
  );
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 100);
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}
