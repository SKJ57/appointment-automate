/**
 * src/pages/Dashboard.tsx
 *
 * The primary daily-use screen (per Section 8.1 of the architecture
 * spec: "Today's bookings — Primary daily-use screen"). Reception
 * lands here after login and uses it between every client.
 *
 * DUMB FRONTEND, SMART BACKEND:
 * This component contains no business logic. It doesn't compute
 * whether a booking can be marked complete, doesn't do overlap math,
 * doesn't decide campaign eligibility. It fetches data via the hooks
 * in useDashboard.ts, renders it, and sends a single command (mark
 * complete) when the button is tapped. Every rule about what happens
 * next lives server-side.
 */

import { useState, type ReactNode } from 'react';
import { CheckCircle2, Clock, XCircle, TrendingUp, IndianRupee, UserPlus } from 'lucide-react';
import { BookingStatus } from '@theslotbot/shared/types';
import type { BookingDto, DailyMetricsDto } from '@theslotbot/shared/types';
import { useTodayBookings, useDailyMetrics, useMarkVisitComplete } from '@/hooks/useDashboard';
import { StatusBadge } from '@/components/StatusBadge';
import { WalkInForm } from '@/components/WalkInForm';
import { useAuthStore } from '@/stores/auth.store';

export function Dashboard() {
  const { data: bookingsData, isLoading: bookingsLoading, error: bookingsError } =
    useTodayBookings();
  const { data: metrics, isLoading: metricsLoading } = useDailyMetrics();
  const markComplete = useMarkVisitComplete();
  const user = useAuthStore((s) => s.user);
  const [showWalkInForm, setShowWalkInForm] = useState(false);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            Today's bookings
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {user ? `Signed in as ${user.name}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowWalkInForm(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover"
        >
          <UserPlus className="h-4 w-4" />
          New walk-in
        </button>
      </header>

      {showWalkInForm && <WalkInForm onClose={() => setShowWalkInForm(false)} />}

      <MetricsRow metrics={metrics} loading={metricsLoading} />

      <section className="mt-6">
        {bookingsLoading && <LoadingState />}

        {bookingsError && (
          <ErrorState message="Couldn't load today's bookings. Check your connection and try again." />
        )}

        {bookingsData && bookingsData.items.length === 0 && <EmptyState />}

        {bookingsData && bookingsData.items.length > 0 && (
          <BookingsTable
            bookings={bookingsData.items}
            onMarkComplete={(id) => markComplete.mutate(id)}
            markingCompleteId={markComplete.isPending ? markComplete.variables : undefined}
          />
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────
// METRICS ROW
// ─────────────────────────────────────────────

function MetricsRow({
  metrics,
  loading,
}: {
  metrics: DailyMetricsDto | undefined;
  loading: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <MetricCard
        icon={<Clock className="h-4 w-4" />}
        label="Scheduled today"
        value={loading ? '—' : metrics?.scheduledToday}
      />
      <MetricCard
        icon={<CheckCircle2 className="h-4 w-4" />}
        label="Completed today"
        value={loading ? '—' : metrics?.completedToday}
      />
      <MetricCard
        icon={<XCircle className="h-4 w-4" />}
        label="Cancelled today"
        value={loading ? '—' : metrics?.cancelledToday}
      />
      <MetricCard
        icon={<TrendingUp className="h-4 w-4" />}
        label="Upcoming (7d)"
        value={loading ? '—' : metrics?.upcomingWeekCount}
      />
      <MetricCard
        icon={<IndianRupee className="h-4 w-4" />}
        label="Revenue today"
        value={loading ? '—' : formatPaise(metrics?.revenueTodayPaise ?? 0)}
      />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string | number | undefined;
}) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-ink-500">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-1.5 text-xl font-semibold text-ink-900">{value ?? '—'}</p>
    </div>
  );
}

function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// ─────────────────────────────────────────────
// BOOKINGS TABLE
// ─────────────────────────────────────────────

function BookingsTable({
  bookings,
  onMarkComplete,
  markingCompleteId,
}: {
  bookings: BookingDto[];
  onMarkComplete: (bookingId: string) => void;
  markingCompleteId: string | undefined;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-3 font-medium">Time</th>
            <th className="px-4 py-3 font-medium">Customer</th>
            <th className="px-4 py-3 font-medium">Service</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {bookings.map((booking) => (
            <BookingRow
              key={booking.id}
              booking={booking}
              onMarkComplete={onMarkComplete}
              isMarkingComplete={markingCompleteId === booking.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BookingRow({
  booking,
  onMarkComplete,
  isMarkingComplete,
}: {
  booking: BookingDto;
  onMarkComplete: (bookingId: string) => void;
  isMarkingComplete: boolean;
}) {
  const canComplete = booking.status === BookingStatus.CONFIRMED;
  const time = new Date(booking.slotStart).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <tr className="hover:bg-ink-50/60">
      <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-900">{time}</td>
      <td className="px-4 py-3">
        <div className="text-ink-900">{booking.customer.name}</div>
        <div className="text-xs text-ink-500">{booking.customer.phoneNumber}</div>
      </td>
      <td className="px-4 py-3 text-ink-700">{booking.service.name}</td>
      <td className="px-4 py-3">
        <StatusBadge status={booking.status} />
      </td>
      <td className="px-4 py-3 text-right">
        {canComplete && (
          <button
            type="button"
            onClick={() => onMarkComplete(booking.id)}
            disabled={isMarkingComplete}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {isMarkingComplete ? 'Marking…' : 'Mark complete'}
          </button>
        )}
        {booking.status === BookingStatus.COMPLETED && (
          <span className="text-xs text-status-completed">✓ Done</span>
        )}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────
// EMPTY / LOADING / ERROR STATES
// ─────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-ink-300 bg-white p-8 text-center">
      <p className="text-sm font-medium text-ink-700">No bookings today</p>
      <p className="mt-1 text-xs text-ink-500">
        New WhatsApp bookings will appear here as customers confirm them.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-8 text-center">
      <p className="text-sm text-ink-500">Loading today's bookings…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-status-noshow/30 bg-status-noshow/5 p-4">
      <p className="text-sm font-medium text-status-noshow">{message}</p>
    </div>
  );
}
