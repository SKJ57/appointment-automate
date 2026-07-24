/**
 * src/api/routes/auth.ts
 *
 * GET  /auth/me              — resolve the current user (Phase 4)
 * GET  /auth/team            — list active team members for this salon
 * POST /auth/invite          — generate an invite (agency_admin, salon_owner)
 * POST /auth/invite/accept   — public, token-gated account creation
 *
 * INVITE ROUTE SCOPE NOTE:
 * This is intentionally minimal, per the Phase 5 brief. There is no
 * GET /auth/invite (listing pending invites) or revoke endpoint yet —
 * an owner who mistypes an email currently has no way to cancel that
 * invite before it's accepted, short of it expiring naturally after
 * 72 hours. Flagging this as a known gap rather than silently omitting
 * it: worth adding before this becomes a support burden at scale.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@theslotbot/shared/types';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, sendError, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import {
  createInvite,
  acceptInvite,
  listTeam,
  buildInviteUrl,
  InviteRoleNotAllowedError,
  InviteTokenInvalidError,
  InviteEmailAlreadyRegisteredError,
} from '@/modules/auth/invite.service';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'routes.auth' });

export const authRouter = Router();

// ─────────────────────────────────────────────
// GET /auth/me
// ─────────────────────────────────────────────

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  sendSuccess(res, req.authUser);
});

// ─────────────────────────────────────────────
// GET /auth/team
// ─────────────────────────────────────────────

authRouter.get('/team', requireAuth, async (_req: Request, res: Response) => {
  try {
    const salonId = await getCurrentSalonId();
    const team = await listTeam(salonId);
    sendSuccess(res, team);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ─────────────────────────────────────────────
// POST /auth/invite
// ─────────────────────────────────────────────

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
});

authRouter.post(
  '/invite',
  requireAuth,
  requireRole(UserRole.SALON_OWNER),
  async (req: Request, res: Response) => {
    const parsed = createInviteSchema.safeParse(req.body);

    if (!parsed.success) {
      sendError(res, {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'A valid email and role are required',
        details: parsed.error.flatten(),
      });
      return;
    }

    if (!req.authUser) {
      handleRouteError(res, new Error('Missing authenticated user'));
      return;
    }

    try {
      const salonId = await getCurrentSalonId();

      const invite = await createInvite({
        email: parsed.data.email,
        role: parsed.data.role,
        salonId,
        invitedByUserId: req.authUser.id,
        invitedByRole: req.authUser.role,
      });

      // The raw token is returned exactly once, embedded in the URL.
      // No email delivery is wired up yet (see note below) — the
      // salon_owner copies this link and shares it themselves.
      sendSuccess(
        res,
        {
          inviteId: invite.inviteId,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
          inviteUrl: buildInviteUrl(invite.rawToken),
        },
        201,
      );
    } catch (err) {
      if (err instanceof InviteRoleNotAllowedError) {
        sendError(res, { statusCode: 403, code: 'FORBIDDEN', message: err.message });
        return;
      }
      if (err instanceof InviteEmailAlreadyRegisteredError) {
        sendError(res, { statusCode: 409, code: 'VALIDATION_ERROR', message: err.message });
        return;
      }
      handleRouteError(res, err);
    }
  },
);

// ─────────────────────────────────────────────
// POST /auth/invite/accept — PUBLIC, no auth required.
// Token itself is the credential; see invite.service.ts.
// ─────────────────────────────────────────────

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1),
});

authRouter.post('/invite/accept', async (req: Request, res: Response) => {
  const parsed = acceptInviteSchema.safeParse(req.body);

  if (!parsed.success) {
    sendError(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'token, password (min 8 chars), and name are required',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const user = await acceptInvite({
      rawToken: parsed.data.token,
      password: parsed.data.password,
      name: parsed.data.name,
    });

    log.info({ userId: user.id, email: user.email }, 'New account created via invite acceptance');

    sendSuccess(res, user, 201);
  } catch (err) {
    if (err instanceof InviteTokenInvalidError) {
      sendError(res, { statusCode: 404, code: 'INVITE_NOT_FOUND', message: err.message });
      return;
    }
    if (err instanceof InviteEmailAlreadyRegisteredError) {
      sendError(res, { statusCode: 409, code: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    handleRouteError(res, err);
  }
});
