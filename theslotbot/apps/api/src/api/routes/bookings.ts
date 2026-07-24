/**
 * src/api/routes/bookings.ts
 *
 * SEPARATION OF CONCERNS:
 * This file does HTTP concerns only — parsing query/body, calling into
 * booking.service.ts, shaping the response envelope. Every business
 * rule (overlap math, idempotency, campaign state resets) lives in the
 * service/repository layers built in Phase 2. If you find yourself
 * writing a Prisma query directly in this file, that's a sign the
 * logic belongs one layer down instead.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { BookingStatus, UserRole } from '@theslotbot/shared/types';
import { PHONE_REGEX } from '@theslotbot/shared/constants';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, sendError, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import { startOfSalonDay, endOfSalonDay } from '@/lib/timezone';
import * as bookingService from '@/modules/booking/booking.service';
import { upsertWalkInCustomer } from '@/modules/booking/customer.service';
import { toBookingDto } from '@/api/serializers';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'routes.bookings' });

export const bookingsRouter = Router();

// All booking routes require authentication; staff and above may act
// on bookings (viewing, creating walk-ins, cancelling).
bookingsRouter.use(requireAuth, requireRole(UserRole.SALON_STAFF, UserRole.SALON_OWNER));

// ─────────────────────────────────────────────
// GET /bookings — list with filters
// ─────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(BookingStatus).optional(),
  today: z.coerce.boolean().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

bookingsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid query parameters',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { page, pageSize, status, today, dateFrom, dateTo } = parsed.data;

  try {
    const salonId = await getCurrentSalonId();

    let from: Date;
    let to: Date;

    if (today) {
      from = startOfSalonDay();
      to = endOfSalonDay();
    } else if (dateFrom && dateTo) {
      from = startOfSalonDay(dateFrom);
      to = endOfSalonDay(dateTo);
    } else {
      // Default window: today through +30 days, so "upcoming bookings"
      // works with no params at all.
      from = startOfSalonDay();
      const horizonDateStr = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0]!;
      to = endOfSalonDay(horizonDateStr);
    }

    const result = await bookingService.listBookings({
      salonId,
      from,
      to,
      status,
      page,
      pageSize,
    });

    sendSuccess(res, {
      items: result.items.map(toBookingDto),
      meta: {
        total: result.total,
        page,
        pageSize,
        totalPages: Math.ceil(result.total / pageSize),
      },
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// GET /bookings/:bookingId
// ─────────────────────────────────────────────

bookingsRouter.get('/:bookingId', async (req: Request, res: Response) => {
  try {
    const salonId = await getCurrentSalonId();
    const booking = await bookingService.getBooking(req.params.bookingId as string, salonId);

    if (!booking) {
      sendError(res, {
        statusCode: 404,
        code: 'BOOKING_NOT_FOUND',
        message: `Booking ${req.params.bookingId} not found`,
      });
      return;
    }

    sendSuccess(res, toBookingDto(booking));
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// POST /bookings — walk-in booking (admin_manual)
// Risk D2 fix lives in upsertWalkInCustomer(), called here.
// ─────────────────────────────────────────────

const createWalkInSchema = z.object({
  customerPhone: z.string().regex(PHONE_REGEX, 'Must be E.164 format, e.g. +919876543210'),
  customerName: z.string().min(1),
  serviceId: z.string().uuid(),
  slotId: z.string().uuid(),
  notes: z.string().optional(),
  markCompleteImmediately: z.boolean().default(false),
});

bookingsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createWalkInSchema.safeParse(req.body);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid booking payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { customerPhone, customerName, serviceId, slotId, notes, markCompleteImmediately } =
    parsed.data;

  try {
    const salonId = await getCurrentSalonId();

    // Risk D2: walk-in upsert always resets campaign state, regardless
    // of the customer's prior standing (non_responder, etc.) — a walk-in
    // is definitionally a fresh visit.
    const customer = await upsertWalkInCustomer({
      salonId,
      phoneNumber: customerPhone,
      name: customerName,
    });

    const [service, slot] = await Promise.all([
      prisma.service.findFirstOrThrow({
        where: { id: serviceId, salonId, isActive: true },
        select: { durationMinutes: true },
      }),
      prisma.slot.findFirstOrThrow({
        where: { id: slotId, salonId },
        select: { startTime: true },
      }),
    ]);

    const booking = await bookingService.createBooking({
      salonId,
      customerId: customer.id,
      serviceId,
      slotId,
      slotStart: slot.startTime,
      durationMinutes: service.durationMinutes,
      source: 'admin_manual',
      notes,
    });

    if (markCompleteImmediately && req.authUser) {
      await bookingService.markBookingComplete({
        bookingId: booking.id,
        salonId,
        completedById: req.authUser.id,
      });
      const completedWithRelations = await bookingService.getBooking(booking.id, salonId);
      sendSuccess(res, toBookingDto(completedWithRelations!), 201);
      return;
    }

    const withRelations = await bookingService.getBooking(booking.id, salonId);
    sendSuccess(res, toBookingDto(withRelations!), 201);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// POST /bookings/:bookingId/cancel
// Queue cleanup (removing reminder jobs) happens inside
// bookingService.cancelBooking() — see Phase 2 booking.service.ts.
// ─────────────────────────────────────────────

const cancelSchema = z.object({
  reason: z.string().optional(),
});

bookingsRouter.patch('/:bookingId/cancel', async (req: Request, res: Response) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const salonId = await getCurrentSalonId();

    const booking = await bookingService.cancelBooking({
      bookingId: req.params.bookingId as string,
      salonId,
      reason: parsed.data.reason,
    });

    log.info(
      { bookingId: booking.id, cancelledBy: req.authUser?.id },
      'Booking cancelled via admin panel',
    );

    const withRelations = await bookingService.getBooking(booking.id, salonId);
    sendSuccess(res, toBookingDto(withRelations!));
  } catch (err) {
    handleRouteError(res, err);
  }
});
