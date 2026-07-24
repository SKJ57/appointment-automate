/**
 * src/hooks/useWalkIn.ts
 *
 * Calls the existing POST /bookings endpoint (Phase 4) — no new
 * backend route for this. That endpoint already runs the walk-in
 * customer upsert with the campaign-state reset (Risk D2) server-side;
 * this hook has no knowledge of that rule, consistent with keeping
 * business logic entirely out of the frontend.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BookingDto } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

export interface CreateWalkInParams {
  customerPhone: string;
  customerName: string;
  serviceId: string;
  slotId: string;
  notes?: string;
  markCompleteImmediately: boolean;
}

export function useCreateWalkIn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: CreateWalkInParams) => apiClient.post<BookingDto>('/bookings', params),
    onSuccess: () => {
      // A walk-in booked (or logged retroactively) for today should
      // show up on the Dashboard immediately.
      void queryClient.invalidateQueries({ queryKey: ['bookings', 'today'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'metrics'] });
    },
  });
}
