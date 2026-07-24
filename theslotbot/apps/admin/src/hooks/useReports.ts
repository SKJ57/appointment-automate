/**
 * src/hooks/useReports.ts
 */

import { useQuery } from '@tanstack/react-query';
import type { CampaignReportRowDto } from '@theslotbot/shared/types';
import { apiClient } from '@/api/client';

export function useCampaignReport(months: number) {
  return useQuery({
    queryKey: ['reports', 'campaign', months],
    queryFn: () => apiClient.get<CampaignReportRowDto[]>(`/admin/reports/campaign?months=${months}`),
  });
}
