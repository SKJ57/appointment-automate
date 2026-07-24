/**
 * src/pages/Slots.tsx
 *
 * A vertical time-list rather than a grid-calendar widget — consistent
 * with the design intent set in tailwind.config.js: this is a tool a
 * reception desk scans quickly, not a visual calendar product. Each
 * row is one slot; color and a short label communicate its state at a
 * glance (open / booked with who+what / blocked).
 */

import { useState } from 'react';
import { Lock, Unlock } from 'lucide-react';
import type { SlotWithBookingDto } from '@theslotbot/shared/types';
import { useDaySlots, useToggleSlotBlock, useBlockWindow } from '@/hooks/useSlots';
import { ApiError } from '@/api/client';

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function Slots() {
  const [date, setDate] = useState(todayLocalDate());
  const { data: slots, isLoading, error } = useDaySlots(date);
  const toggleBlock = useToggleSlotBlock(date);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Slots</h1>
        <p className="mt-1 text-sm text-ink-500">View capacity and block time for staff breaks.</p>
      </header>

      <div className="mb-6 flex items-center gap-3">
        <label htmlFor="date" className="text-sm font-medium text-ink-700">
          Date
        </label>
        <input
          id="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-ink-200 px-3 py-1.5 text-sm focus:border-accent"
        />
      </div>

      <BlockWindowForm date={date} />

      <section className="mt-6">
        {isLoading && <p className="text-sm text-ink-500">Loading slots…</p>}
        {error && (
          <p className="rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
            Couldn't load slots for this date.
          </p>
        )}
        {slots && slots.length === 0 && (
          <p className="rounded-lg border border-dashed border-ink-300 bg-white p-6 text-center text-sm text-ink-500">
            No slots generated for this date yet.
          </p>
        )}
        {slots && slots.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-ink-200 bg-white">
            {slots.map((slot) => (
              <SlotRow
                key={slot.id}
                slot={slot}
                onToggleBlock={(isBlocked) => toggleBlock.mutate({ slotId: slot.id, isBlocked })}
                isToggling={toggleBlock.isPending && toggleBlock.variables?.slotId === slot.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SlotRow({
  slot,
  onToggleBlock,
  isToggling,
}: {
  slot: SlotWithBookingDto;
  onToggleBlock: (isBlocked: boolean) => void;
  isToggling: boolean;
}) {
  const time = new Date(slot.startTime).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const hasBooking = slot.booking !== null;

  return (
    <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="w-16 text-sm font-medium text-ink-900">{time}</span>

        {hasBooking && slot.booking && (
          <span className="rounded-full bg-status-confirmed/10 px-2.5 py-0.5 text-xs font-medium text-status-confirmed">
            {slot.booking.customerName} — {slot.booking.serviceName}
          </span>
        )}

        {!hasBooking && slot.isBlocked && (
          <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs font-medium text-ink-500">
            Blocked
          </span>
        )}

        {!hasBooking && !slot.isBlocked && (
          <span className="rounded-full bg-status-completed/10 px-2.5 py-0.5 text-xs font-medium text-status-completed">
            Open
          </span>
        )}
      </div>

      {!hasBooking && (
        <button
          type="button"
          onClick={() => onToggleBlock(!slot.isBlocked)}
          disabled={isToggling}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-ink-100 disabled:opacity-50"
        >
          {slot.isBlocked ? (
            <>
              <Unlock className="h-3 w-3" /> Unblock
            </>
          ) : (
            <>
              <Lock className="h-3 w-3" /> Block
            </>
          )}
        </button>
      )}
    </div>
  );
}

function BlockWindowForm({ date }: { date: string }) {
  const [startTime, setStartTime] = useState('13:00');
  const [endTime, setEndTime] = useState('14:00');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blockWindow = useBlockWindow(date);

  const handleSubmit = async () => {
    setError(null);
    setResult(null);
    try {
      const response = await blockWindow.mutateAsync({ startTime, endTime, reason: reason || undefined });
      setResult(response.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to block this time window.');
    }
  };

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-ink-900">Block a time window</h2>
      <p className="mt-0.5 text-xs text-ink-500">
        For staff breaks or closures. Slots with an existing booking are left untouched.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="startTime" className="block text-xs font-medium text-ink-600">
            Start
          </label>
          <input
            id="startTime"
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="mt-1 rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="endTime" className="block text-xs font-medium text-ink-600">
            End
          </label>
          <input
            id="endTime"
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="mt-1 rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="reason" className="block text-xs font-medium text-ink-600">
            Reason (optional)
          </label>
          <input
            id="reason"
            type="text"
            placeholder="Lunch break"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={blockWindow.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {blockWindow.isPending ? 'Blocking…' : 'Block'}
        </button>
      </div>

      {result && <p className="mt-2 text-xs text-status-completed">{result}</p>}
      {error && <p className="mt-2 text-xs text-status-noshow">{error}</p>}
    </div>
  );
}
