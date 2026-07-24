/**
 * src/hooks/useDashboard.ts
 *
 * All TanStack Query wiring for the Dashboard view lives here, not
 * inline in the component. Dashboard.tsx only calls these hooks and
 * renders what they return — it never calls apiClient directly.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { BookingDto, DailyMetricsDto, PaginatedBookings } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

const TODAY_BOOKINGS_KEY = ['bookings', 'today'] as const;
const METRICS_KEY = ['dashboard', 'metrics'] as const;

export function useTodayBookings() {
  return useQuery({
    queryKey: TODAY_BOOKINGS_KEY,
    queryFn: () => apiClient.get<PaginatedBookings>('/bookings?today=true&pageSize=100'),
    // Reception glances at this screen between clients all day — a
    // short refetch interval keeps it close to live without hammering
    // the API on every render.
    refetchInterval: 60_000,
  });
}

export function useDailyMetrics() {
  return useQuery({
    queryKey: METRICS_KEY,
    queryFn: () => apiClient.get<DailyMetricsDto>('/admin/dashboard/metrics'),
    refetchInterval: 60_000,
  });
}

/**
 * Mark Visit Complete, with an optimistic update.
 *
 * The booking's status flips to 'completed' in the UI the instant the
 * button is tapped — reception shouldn't wait on a network round trip
 * to see the tap register, especially on a shaky salon wifi connection.
 * If the server call fails (network error, or the backend rejects the
 * transition — e.g. someone already cancelled this booking from another
 * device), the optimistic update is rolled back to the previous list
 * and the error is surfaced.
 */
export function useMarkVisitComplete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bookingId: string) =>
      apiClient.post<BookingDto>(`/admin/dashboard/bookings/${bookingId}/complete`),

    onMutate: async (bookingId: string) => {
      await queryClient.cancelQueries({ queryKey: TODAY_BOOKINGS_KEY });

      const previous = queryClient.getQueryData<PaginatedBookings>(TODAY_BOOKINGS_KEY);

      if (previous) {
        queryClient.setQueryData<PaginatedBookings>(TODAY_BOOKINGS_KEY, {
          ...previous,
          items: previous.items.map((b) =>
            b.id === bookingId ? { ...b, status: 'completed' as const } : b,
          ),
        });
      }

      return { previous };
    },

    onError: (_err, _bookingId, context) => {
      // Roll back to the pre-mutation snapshot on failure.
      if (context?.previous) {
        queryClient.setQueryData(TODAY_BOOKINGS_KEY, context.previous);
      }
    },

    onSettled: () => {
      // Reconcile with the server's actual state either way — this
      // also picks up the metrics change (completedToday count) that
      // the optimistic update above doesn't touch.
      void queryClient.invalidateQueries({ queryKey: TODAY_BOOKINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: METRICS_KEY });
    },
  });
}
