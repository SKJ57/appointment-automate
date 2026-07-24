/**
 * src/hooks/useServices.ts
 */

import { useQuery } from '@tanstack/react-query';
import type { ServiceDto } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => apiClient.get<ServiceDto[]>('/services'),
    staleTime: 5 * 60_000, // service catalogue changes rarely
  });
}
