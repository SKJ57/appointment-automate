/**
 * src/hooks/useSlots.ts
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SlotWithBookingDto, SlotDto } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

const daySlotsKey = (date: string) => ['slots', 'day', date] as const;

export function useDaySlots(date: string) {
  return useQuery({
    queryKey: daySlotsKey(date),
    queryFn: () => apiClient.get<SlotWithBookingDto[]>(`/slots/day?date=${date}`),
  });
}

/**
 * Service-scoped availability, for the WalkInForm slot picker. Reuses
 * the same GET /slots endpoint (and the same overlap-aware repository
 * query) the WhatsApp booking flow uses internally — walk-ins get
 * identical correctness guarantees, not a separate, less-safe path.
 */
export function useAvailableSlots(date: string, serviceId: string | null) {
  return useQuery({
    queryKey: ['slots', 'available', date, serviceId],
    queryFn: () => apiClient.get<SlotDto[]>(`/slots?date=${date}&serviceId=${serviceId}`),
    enabled: Boolean(serviceId),
  });
}

export function useToggleSlotBlock(date: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { slotId: string; isBlocked: boolean }) =>
      apiClient.patch<SlotDto>(`/slots/${params.slotId}/block`, { isBlocked: params.isBlocked }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: daySlotsKey(date) });
    },
  });
}

export interface BlockWindowResult {
  blockedCount: number;
  conflictingSlotIds: string[];
  message: string;
}

export function useBlockWindow(date: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { startTime: string; endTime: string; reason?: string }) =>
      apiClient.post<BlockWindowResult>('/slots/block-window', { date, ...params }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: daySlotsKey(date) });
    },
  });
}
