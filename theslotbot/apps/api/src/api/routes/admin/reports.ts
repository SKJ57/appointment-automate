/**
 * src/api/routes/admin/reports.ts
 *
 * salon_owner only (staff cannot see this — Section 8.1 marks the
 * Revisit campaign report as "Owner only"). requireRole with just
 * SALON_OWNER means salon_staff is rejected; agency_admin still
 * passes via the universal bypass in requireRole.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@theslotbot/shared/types';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, sendError, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import { getCampaignReport } from '@/modules/campaign/campaign-report.service';

export const adminReportsRouter = Router();

adminReportsRouter.use(requireAuth, requireRole(UserRole.SALON_OWNER));

const reportQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(3),
});

adminReportsRouter.get('/campaign', async (req: Request, res: Response) => {
  const parsed = reportQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'months must be an integer between 1 and 12',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const salonId = await getCurrentSalonId();
    const report = await getCampaignReport(salonId, parsed.data.months);
    sendSuccess(res, report);
  } catch (err) {
    handleRouteError(res, err);
  }
});
