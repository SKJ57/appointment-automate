/**
 * src/components/StatusBadge.tsx
 *
 * One badge component, used everywhere a BookingStatus is displayed.
 * Colors are defined once in tailwind.config.js (the `status.*` tokens)
 * and referenced here by name — never hardcoded hex values inline,
 * so the palette stays a single source of truth.
 */

import type { BookingStatus } from '@theslotbot/shared/types';

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending_confirmation: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

const STATUS_CLASSES: Record<BookingStatus, string> = {
  pending_confirmation: 'bg-status-pending/10 text-status-pending border-status-pending/30',
  confirmed: 'bg-status-confirmed/10 text-status-confirmed border-status-confirmed/30',
  completed: 'bg-status-completed/10 text-status-completed border-status-completed/30',
  cancelled: 'bg-status-cancelled/10 text-status-cancelled border-status-cancelled/30',
  no_show: 'bg-status-noshow/10 text-status-noshow border-status-noshow/30',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
