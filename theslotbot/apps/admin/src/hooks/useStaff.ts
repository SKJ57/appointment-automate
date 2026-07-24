/**
 * src/hooks/useStaff.ts
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TeamMemberDto, CreateInviteResponseDto, UserRole } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

const TEAM_KEY = ['team'] as const;

export function useTeam() {
  return useQuery({
    queryKey: TEAM_KEY,
    queryFn: () => apiClient.get<TeamMemberDto[]>('/auth/team'),
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { email: string; role: UserRole }) =>
      apiClient.post<CreateInviteResponseDto>('/auth/invite', params),
    onSuccess: () => {
      // The invited person isn't on the team roster until they accept,
      // so this doesn't change GET /auth/team's result yet — invalidating
      // anyway keeps the roster fresh in case of any related side effects.
      void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    },
  });
}
