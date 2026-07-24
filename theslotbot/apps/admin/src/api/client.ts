/**
 * src/api/client.ts
 *
 * Thin fetch wrapper. Every call:
 *   1. Attaches the current Supabase access token as a Bearer header.
 *   2. Unwraps the ApiResponse<T> envelope (success/data or success/error).
 *   3. Throws a typed ApiError on failure so TanStack Query's error
 *      state carries the backend's error code and message, not just
 *      an HTTP status.
 *
 * SEPARATION OF CONCERNS:
 * This file has zero business logic. It doesn't know what a booking
 * is or what "overlap" means — it only knows how to call an endpoint
 * and unwrap a response. All domain logic stays server-side, per the
 * Phase 4 constraint: keep the frontend dumb, the backend smart.
 */

import type { ApiResponse } from '@theslotbot/shared/types';
import { supabase } from '@/lib/supabaseClient';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const authHeader = await getAuthHeader();

  const response = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
      ...options.headers,
    },
  });

  const body = (await response.json()) as ApiResponse<T>;

  if (!body.success) {
    throw new ApiError(body.error.code, body.error.message, response.status, body.error.details);
  }

  return body.data;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};
