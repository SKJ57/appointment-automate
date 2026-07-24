/**
 * src/api/respond.ts
 *
 * Every route handler responds through these two helpers so the
 * response body always matches ApiResponse<T> from
 * packages/shared/types/index.ts — the same type the Admin Panel
 * imports to type its API client responses. This is the actual
 * enforcement point of the "strict API contract" requirement: the
 * envelope shape isn't just documented in the OpenAPI spec, it's
 * structurally impossible to violate from within a route that uses
 * these helpers.
 */

import { Response } from 'express';
import { ApiSuccessResponse, ApiErrorResponse } from '@theslotbot/shared/types';
import { ErrorCode, ERROR_CODES } from '@theslotbot/shared/constants';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'api.respond' });

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
): void {
  const body: ApiSuccessResponse<T> = { success: true, data };
  res.status(statusCode).json(body);
}

export function sendError(
  res: Response,
  params: { statusCode: number; code: ErrorCode | string; message: string; details?: unknown },
): void {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: params.code,
      message: params.message,
      details: params.details,
    },
  };
  res.status(params.statusCode).json(body);
}

/**
 * Maps a thrown domain error (from booking.repository.ts,
 * customer.service.ts, etc.) to the correct HTTP status and error
 * envelope. Every domain error class in this codebase carries a
 * `.code` property from ERROR_CODES — this function reads that and
 * picks the appropriate status, so route handlers don't each need
 * their own switch statement over error types.
 *
 * Falls back to 500/INTERNAL_SERVER_ERROR for anything unrecognised,
 * and logs those at error level since an unmapped error type reaching
 * a route handler usually indicates a new failure mode that should
 * get its own explicit mapping here.
 */
export function handleRouteError(res: Response, err: unknown): void {
  const typedErr = err as Error & { code?: string };

  const statusMap: Record<string, number> = {
    [ERROR_CODES.SLOT_ALREADY_CLAIMED]: 409,
    [ERROR_CODES.SLOT_OVERLAP_DETECTED]: 409,
    [ERROR_CODES.SLOT_NOT_FOUND]: 404,
    [ERROR_CODES.BOOKING_NOT_FOUND]: 404,
    [ERROR_CODES.BOOKING_NOT_CANCELLABLE]: 409,
    [ERROR_CODES.INVALID_BOOKING_STATUS_TRANSITION]: 409,
    [ERROR_CODES.VALIDATION_ERROR]: 400,
    [ERROR_CODES.UNAUTHORIZED]: 401,
    [ERROR_CODES.FORBIDDEN]: 403,
    [ERROR_CODES.NOT_FOUND]: 404,
  };

  const code = typedErr.code;

  if (code && statusMap[code]) {
    sendError(res, {
      statusCode: statusMap[code],
      code,
      message: typedErr.message,
    });
    return;
  }

  log.error({ err }, 'Unmapped error reached route handler — returning 500');
  sendError(res, {
    statusCode: 500,
    code: ERROR_CODES.INTERNAL_SERVER_ERROR,
    message: 'An unexpected error occurred',
  });
}
