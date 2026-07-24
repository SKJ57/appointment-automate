/**
 * src/api/middleware/authMiddleware.ts
 *
 * INVITE-ONLY AUTH, ENFORCED SERVER-SIDE:
 * A valid Supabase JWT alone is NOT sufficient to access any admin
 * route. Supabase Auth only proves "this person authenticated
 * successfully" — it says nothing about whether they were invited.
 * Our own `User` table is the actual authorization source of truth:
 * every row in it was created either by the seed script (agency_admin,
 * salon_owner) or by the invite-acceptance endpoint (salon_staff).
 * There is no code path anywhere in this system that creates a User
 * row from an unsolicited signup, because no public signup endpoint
 * exists.
 *
 * This middleware:
 *   1. Extracts the Bearer token from the Authorization header.
 *   2. Verifies it with Supabase Auth (network call to
 *      supabase.auth.getUser(token) — this both validates the JWT
 *      signature/expiry and confirms the session hasn't been revoked).
 *   3. Looks up our User row by supabaseUserId.
 *   4. If no User row exists — a Supabase account that was never
 *      invited into our system, or whose invite was later revoked and
 *      the User row removed — the request is rejected with 401,
 *      regardless of how valid the Supabase session itself is.
 *   5. Attaches the resolved user (id, role, salonId, email, name) to
 *      req.authUser for downstream route handlers and role guards.
 *
 * ROLE GUARD:
 * requireRole(...) is a middleware factory. agency_admin always passes
 * every guard (cross-salon operational access is inherent to that
 * role). Other roles must appear explicitly in the allowed list.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createClient } from '@supabase/supabase-js';
import { UserRole } from '@theslotbot/shared/types';
import { ERROR_CODES } from '@theslotbot/shared/constants';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sendError } from '@/api/respond';

const log = logger.child({ module: 'authMiddleware' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for auth middleware',
  );
}

// Service-role client: used server-side only, to verify tokens and
// (in the invite-accept flow, not in this file) to create auth users.
// Never expose this key or this client instance to the frontend.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface AuthenticatedUser {
  id: string; // our User.id, not the Supabase auth user id
  supabaseUserId: string;
  email: string;
  name: string;
  role: UserRole;
  salonId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

// ─────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────

export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, {
      statusCode: 401,
      code: ERROR_CODES.UNAUTHORIZED,
      message: 'Authentication required',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    log.debug({ error: error?.message }, 'Supabase token validation failed');
    sendError(res, {
      statusCode: 401,
      code: ERROR_CODES.UNAUTHORIZED,
      message: 'Invalid or expired session',
    });
    return;
  }

  // ── Invite-only enforcement ─────────────────────────────────────────
  // A valid Supabase session with no corresponding User row means this
  // person authenticated with Supabase but was never invited into
  // theslotbot. Reject regardless of Supabase session validity.
  const ourUser = await prisma.user.findUnique({
    where: { supabaseUserId: data.user.id },
    select: {
      id: true,
      supabaseUserId: true,
      email: true,
      name: true,
      role: true,
      salonId: true,
      isActive: true,
    },
  });

  if (!ourUser || !ourUser.isActive) {
    log.warn(
      { supabaseUserId: data.user.id, found: Boolean(ourUser) },
      'Valid Supabase session but no active invited User record — rejecting',
    );
    sendError(res, {
      statusCode: 401,
      code: ERROR_CODES.UNAUTHORIZED,
      message: 'This account is not authorized to access theslotbot',
    });
    return;
  }

  req.authUser = {
    id: ourUser.id,
    supabaseUserId: ourUser.supabaseUserId,
    email: ourUser.email,
    name: ourUser.name,
    role: ourUser.role as UserRole,
    salonId: ourUser.salonId,
  };

  next();
};

// ─────────────────────────────────────────────
// ROLE GUARD
// ─────────────────────────────────────────────

/**
 * Restricts a route to the given roles. agency_admin always passes,
 * regardless of whether it's listed explicitly — that role represents
 * theslotbot's own team and is trusted with full operational access
 * across every client deployment's admin surface.
 *
 * Must be mounted AFTER requireAuth on the same route.
 */
export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.authUser;

    if (!user) {
      // Defensive — should be unreachable if requireAuth ran first.
      log.error('requireRole invoked without requireAuth having run first');
      sendError(res, {
        statusCode: 401,
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Authentication required',
      });
      return;
    }

    if (user.role === UserRole.AGENCY_ADMIN || allowedRoles.includes(user.role)) {
      next();
      return;
    }

    sendError(res, {
      statusCode: 403,
      code: ERROR_CODES.FORBIDDEN,
      message: 'Your role does not have access to this resource',
    });
  };
}
