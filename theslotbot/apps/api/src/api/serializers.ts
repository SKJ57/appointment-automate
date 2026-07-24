/**
 * src/api/serializers.ts
 *
 * Explicit mapping functions from Prisma query results to the shared
 * DTOs in packages/shared/types/index.ts.
 *
 * WHY THIS FILE EXISTS:
 * Route handlers could pass Prisma objects straight to sendSuccess()
 * and, for most fields, the JSON would look right — Prisma's Date
 * objects serialize to ISO strings automatically. But "looks right"
 * isn't the same guarantee as "is the type the frontend imports."
 * Prisma models carry fields the DTOs deliberately omit (e.g.
 * Customer.salonId, Booking.completedById), and a Prisma model can
 * drift from its DTO silently — add a column, and it starts leaking
 * into API responses with no compiler error anywhere, because nothing
 * forces the Prisma type through the DTO's shape.
 *
 * These functions are that forcing point. Each one's return type
 * annotation is the DTO itself, so adding a field to a Prisma model
 * does NOT change what a route returns until someone deliberately
 * updates the corresponding serializer here.
 */

import {
  Booking,
  Customer,
  Slot,
  Service,
} from '@prisma/client';
import {
  BookingDto,
  CustomerDto,
  SlotDto,
  ServiceDto,
  SlotWithBookingDto,
} from '@theslotbot/shared/types';

export function toCustomerDto(customer: Customer): CustomerDto {
  return {
    id: customer.id,
    phoneNumber: customer.phoneNumber,
    name: customer.name,
    whatsappOptIn: customer.whatsappOptIn,
    lastVisitDate: customer.lastVisitDate
      ? customer.lastVisitDate.toISOString().split('T')[0]!
      : null,
    revisitCampaignStatus: customer.revisitCampaignStatus,
    nonResponderCount: customer.nonResponderCount,
    isNumberInvalid: customer.isNumberInvalid,
  };
}

export function toServiceDto(service: Service): ServiceDto {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: service.price,
    durationMinutes: service.durationMinutes,
    category: service.category,
    isActive: service.isActive,
    displayOrder: service.displayOrder,
  };
}

export function toSlotDto(slot: Slot): SlotDto {
  return {
    id: slot.id,
    startTime: slot.startTime.toISOString(),
    endTime: slot.endTime.toISOString(),
    isBlocked: slot.isBlocked,
    bookingId: slot.bookingId,
  };
}

/**
 * Maps a Booking with its required relations to BookingDto.
 * The `service` field only needs the subset BookingDto.service picks —
 * callers can pass either a full Service or the narrower select shape
 * used by findBookingById/findBookingsByDateRange in the repository.
 */
export function toBookingDto(
  booking: Booking & {
    customer: Customer;
    service: Pick<Service, 'id' | 'name' | 'durationMinutes' | 'category'>;
  },
): BookingDto {
  return {
    id: booking.id,
    status: booking.status,
    source: booking.source,
    slotStart: booking.slotStart.toISOString(),
    slotEnd: booking.slotEnd.toISOString(),
    actualVisitDate: booking.actualVisitDate.toISOString().split('T')[0]!,
    reminder24hSent: booking.reminder24hSent,
    reminder3hSent: booking.reminder3hSent,
    reviewRequestSent: booking.reviewRequestSent,
    completedAt: booking.completedAt ? booking.completedAt.toISOString() : null,
    cancelledAt: booking.cancelledAt ? booking.cancelledAt.toISOString() : null,
    notes: booking.notes,
    customer: toCustomerDto(booking.customer),
    service: {
      id: booking.service.id,
      name: booking.service.name,
      durationMinutes: booking.service.durationMinutes,
      category: booking.service.category,
    },
  };
}

/**
 * Maps a Slot (with its optional booking + minimal customer/service
 * relations, as returned by findSlotsForDay) to SlotWithBookingDto —
 * the shape the admin Slots capacity view consumes.
 */
export function toSlotWithBookingDto(
  slot: Slot & {
    booking:
      | (Booking & {
          customer: Pick<Customer, 'name'>;
          service: Pick<Service, 'name'>;
        })
      | null;
  },
): SlotWithBookingDto {
  return {
    ...toSlotDto(slot),
    booking: slot.booking
      ? {
          id: slot.booking.id,
          status: slot.booking.status,
          customerName: slot.booking.customer.name,
          serviceName: slot.booking.service.name,
        }
      : null,
  };
}
