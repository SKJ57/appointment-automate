/**
 * src/components/WalkInForm.tsx
 *
 * DUMB FRONTEND REMINDER:
 * This form does not decide anything about campaign eligibility,
 * overlap safety, or opt-in status. It collects five fields and sends
 * one POST. Everything Section 8.1 describes ("this is how walk-ins
 * enter the revisit campaign eligibility pool") happens in
 * upsertWalkInCustomer() on the backend, not here.
 *
 * Rendered as a modal, triggered from the Dashboard toolbar — see
 * Dashboard.tsx for the trigger button.
 */

import { useState, FormEvent } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { useServices } from '@/hooks/useServices';
import { useAvailableSlots } from '@/hooks/useSlots';
import { useCreateWalkIn } from '@/hooks/useWalkIn';

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function WalkInForm({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState('+91');
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date] = useState(todayLocalDate()); // walk-ins are always logged for today
  const [slotId, setSlotId] = useState('');
  const [notes, setNotes] = useState('');
  const [markCompleteImmediately, setMarkCompleteImmediately] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: services, isLoading: servicesLoading } = useServices();
  const { data: slots, isLoading: slotsLoading } = useAvailableSlots(date, serviceId || null);
  const createWalkIn = useCreateWalkIn();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!serviceId || !slotId) {
      setError('Please select a service and a time slot.');
      return;
    }

    try {
      await createWalkIn.mutateAsync({
        customerPhone: phone,
        customerName: name,
        serviceId,
        slotId,
        notes: notes || undefined,
        markCompleteImmediately,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to log walk-in. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink-900">Log a walk-in</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-ink-700">
              Customer phone
            </label>
            <input
              id="phone"
              type="tel"
              required
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="name" className="block text-sm font-medium text-ink-700">
              Customer name
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="service" className="block text-sm font-medium text-ink-700">
              Service
            </label>
            <select
              id="service"
              required
              value={serviceId}
              onChange={(e) => {
                setServiceId(e.target.value);
                setSlotId(''); // reset slot choice when service changes
              }}
              disabled={servicesLoading}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            >
              <option value="">
                {servicesLoading ? 'Loading services…' : 'Select a service'}
              </option>
              {services?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMinutes} min)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="slot" className="block text-sm font-medium text-ink-700">
              Time slot (today)
            </label>
            <select
              id="slot"
              required
              value={slotId}
              onChange={(e) => setSlotId(e.target.value)}
              disabled={!serviceId || slotsLoading}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent disabled:bg-ink-50"
            >
              <option value="">
                {!serviceId
                  ? 'Choose a service first'
                  : slotsLoading
                    ? 'Loading slots…'
                    : slots?.length === 0
                      ? 'No slots available today'
                      : 'Select a time'}
              </option>
              {slots?.map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {new Date(slot.startTime).toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-ink-700">
              Notes (optional)
            </label>
            <input
              id="notes"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={markCompleteImmediately}
              onChange={(e) => setMarkCompleteImmediately(e.target.checked)}
              className="rounded border-ink-300"
            />
            Mark as completed immediately (customer already visited)
          </label>

          {error && (
            <p className="rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createWalkIn.isPending}
              className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {createWalkIn.isPending ? 'Logging…' : 'Log walk-in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
