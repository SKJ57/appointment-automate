/**
 * src/api/routes/admin/dashboard.ts
 *
 * The "Mark Visit Complete" endpoint is the single most-used admin
 * action in the whole system per Section 8.2 of the original spec —
 * reception taps this after every customer walks out. The route itself
 * is thin: auth check, param validation, delegate to
 * bookingService.markBookingComplete(), which (from Phase 2) already:
 *   - sets status = completed, completedAt, completedById
 *   - sets customer.lastVisitDate from actualVisitDate (Risk D1)
 *   - resets customer.revisitCampaignStatus to 'none'
 *   - enqueues the review request job via reviewQueue (Risk C1-safe,
 *     quiet-hours-aware — see scheduleReviewRequest in booking.service.ts)
 * Nothing about that logic is duplicated or re-implemented here.
 */

import { Router, Request, Response } from 'express';
import { UserRole } from '@theslotbot/shared/types';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import * as bookingService from '@/modules/booking/booking.service';
import { getDailyMetrics } from '@/modules/admin/dashboard.service';
import { toBookingDto } from '@/api/serializers';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'routes.admin.dashboard' });

export const adminDashboardRouter = Router();

adminDashboardRouter.use(
  requireAuth,
  requireRole(UserRole.SALON_STAFF, UserRole.SALON_OWNER),
);

// ─────────────────────────────────────────────
// GET /admin/dashboard/metrics
// ─────────────────────────────────────────────

adminDashboardRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const salonId = await getCurrentSalonId();
    const metrics = await getDailyMetrics(salonId);
    sendSuccess(res, metrics);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// POST /admin/dashboard/bookings/:bookingId/complete
// ─────────────────────────────────────────────

adminDashboardRouter.post(
  '/bookings/:bookingId/complete',
  async (req: Request, res: Response) => {
    if (!req.authUser) {
      // Unreachable given requireAuth ran first — defensive only.
      handleRouteError(res, new Error('Missing authenticated user'));
      return;
    }

    try {
      const salonId = await getCurrentSalonId();

      const booking = await bookingService.markBookingComplete({
        bookingId: req.params.bookingId as string,
        salonId,
        completedById: req.authUser.id,
      });

      log.info(
        { bookingId: booking.id, completedBy: req.authUser.id },
        'Booking marked complete via admin panel — review request enqueued',
      );

      const withRelations = await bookingService.getBooking(booking.id, salonId);
      sendSuccess(res, toBookingDto(withRelations!));
    } catch (err) {
      handleRouteError(res, err);
    }
  },
);
