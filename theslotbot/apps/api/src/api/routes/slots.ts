/**
 * src/api/routes/slots.ts
 *
 * GET /slots delegates entirely to bookingService.getAvailableSlots(),
 * which itself delegates to findAvailableSlots() in the repository —
 * the same overlap-aware query built and tested in Phase 2. This route
 * does not reimplement any of that math; it only translates HTTP query
 * params into the service call's shape.
 *
 * The slot grid granularity itself (CLIENT_CONFIG.booking.
 * slotGridIntervalMinutes) is never referenced directly here — it's
 * baked into which Slot rows exist in the database, produced by the
 * nightly slot-generation worker. This route just reads what's there.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@theslotbot/shared/types';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, sendError, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import { startOfSalonDay, endOfSalonDay, zonedDateStringToUtc } from '@/lib/timezone';
import * as bookingService from '@/modules/booking/booking.service';
import { toSlotDto, toSlotWithBookingDto } from '@/api/serializers';

export const slotsRouter = Router();

slotsRouter.use(requireAuth, requireRole(UserRole.SALON_STAFF, UserRole.SALON_OWNER));

// ─────────────────────────────────────────────
// GET /slots/day — full-day capacity view (admin calendar)
// Distinct from GET /slots below: this returns every slot for the
// day regardless of service, with booking summaries attached, so
// reception can see the whole day's capacity at a glance rather than
// filtering by one service at a time.
// ─────────────────────────────────────────────

const dayViewQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

slotsRouter.get('/day', async (req: Request, res: Response) => {
  const parsed = dayViewQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'date (YYYY-MM-DD) is required',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const salonId = await getCurrentSalonId();

    const slots = await bookingService.getDaySlots({
      salonId,
      dayStart: startOfSalonDay(parsed.data.date),
      dayEnd: endOfSalonDay(parsed.data.date),
    });

    sendSuccess(res, slots.map(toSlotWithBookingDto));
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// GET /slots — available slots for a date + service
// ─────────────────────────────────────────────

const availabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  serviceId: z.string().uuid(),
});

slotsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = availabilityQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid query parameters — date (YYYY-MM-DD) and serviceId (uuid) are required',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { date, serviceId } = parsed.data;

  try {
    const salonId = await getCurrentSalonId();

    const slots = await bookingService.getAvailableSlots({
      salonId,
      serviceId,
      dateStart: startOfSalonDay(date),
      dateEnd: endOfSalonDay(date),
    });

    sendSuccess(res, slots.map(toSlotDto));
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// PATCH /slots/:slotId/block — toggle a single slot
// ─────────────────────────────────────────────

const toggleBlockSchema = z.object({
  isBlocked: z.boolean(),
});

slotsRouter.patch('/:slotId/block', async (req: Request, res: Response) => {
  const parsed = toggleBlockSchema.safeParse(req.body);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'isBlocked (boolean) is required',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const salonId = await getCurrentSalonId();

    const slot = await bookingService.blockSlot({
      slotId: req.params.slotId as string,
      salonId,
      isBlocked: parsed.data.isBlocked,
    });

    sendSuccess(res, toSlotDto(slot));
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// POST /slots/block-window — block a time range on a date
// (e.g. "staff lunch break 1pm–2pm on 2026-08-15")
// ─────────────────────────────────────────────

const blockWindowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:mm'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:mm'),
  reason: z.string().optional(),
});

slotsRouter.post('/block-window', async (req: Request, res: Response) => {
  const parsed = blockWindowSchema.safeParse(req.body);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'date (YYYY-MM-DD), startTime and endTime (HH:mm) are required',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { date, startTime, endTime, reason } = parsed.data;

  try {
    const salonId = await getCurrentSalonId();

    const windowStart = zonedDateStringToUtc(date, `${startTime}:00`);
    const windowEnd = zonedDateStringToUtc(date, `${endTime}:00`);

    if (windowEnd <= windowStart) {
      sendError(res, {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'endTime must be after startTime',
      });
      return;
    }

    const result = await bookingService.blockTimeWindow({
      salonId,
      windowStart,
      windowEnd,
      reason,
    });

    sendSuccess(res, {
      blockedCount: result.blockedCount,
      conflictingSlotIds: result.conflictingSlotIds,
      message:
        result.conflictingSlotIds.length > 0
          ? `Blocked ${result.blockedCount} slots. ${result.conflictingSlotIds.length} slot(s) in this window already have a booking and were left untouched.`
          : `Blocked ${result.blockedCount} slots.`,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});
