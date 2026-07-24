/**
 * src/modules/auth/invite.service.ts
 *
 * ROLE RESTRICTION RULE:
 * salon_owner can only invite salon_staff — they cannot create another
 * owner or an agency_admin. agency_admin can invite any role. This is
 * enforced here, not just via the route's requireRole guard, because
 * requireRole only checks "can this person hit this endpoint at all,"
 * not "is the specific role they're trying to grant one they're
 * allowed to grant." Those are different questions.
 *
 * ACCEPTANCE FLOW:
 * acceptInvite() is the ONLY code path in this entire codebase that
 * creates a Supabase Auth user. There is no public sign-up endpoint
 * anywhere else. It:
 *   1. Hashes the provided raw token and looks up the invite by hash.
 *   2. Validates status === pending and expiresAt is in the future.
 *   3. Creates the Supabase Auth user via the Admin API.
 *   4. Creates our User row with the role and salonId from the invite.
 *   5. Marks the invite accepted.
 * Steps 3-5 are not wrapped in a single DB transaction because step 3
 * is an external API call (Supabase), not a local DB operation — if
 * step 4 fails after step 3 succeeds, we're left with an orphaned
 * Supabase auth user and no local User row. This is handled by
 * catching that specific failure and attempting to delete the
 * just-created Supabase user, so a failed acceptance doesn't leave a
 * half-created account that would fail differently on retry (Supabase
 * would reject a second createUser call for the same email).
 */

import { createClient } from '@supabase/supabase-js';
import { UserRole, InviteStatus } from '@theslotbot/shared/types';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { generateInviteToken, hashInviteToken, computeInviteExpiry } from './inviteToken';

const log = logger.child({ module: 'invite.service' });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_PANEL_URL = process.env.ADMIN_PANEL_URL!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────

export class InviteRoleNotAllowedError extends Error {
  constructor(inviterRole: UserRole, requestedRole: UserRole) {
    super(`A ${inviterRole} cannot create an invite for role ${requestedRole}.`);
    this.name = 'InviteRoleNotAllowedError';
  }
}

export class InviteTokenInvalidError extends Error {
  constructor() {
    super('This invite link is invalid, expired, or has already been used.');
    this.name = 'InviteTokenInvalidError';
  }
}

export class InviteEmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`);
    this.name = 'InviteEmailAlreadyRegisteredError';
  }
}

// ─────────────────────────────────────────────
// ROLE RESTRICTION
// ─────────────────────────────────────────────

const ROLES_INVITABLE_BY: Record<UserRole, UserRole[]> = {
  [UserRole.AGENCY_ADMIN]: [UserRole.AGENCY_ADMIN, UserRole.SALON_OWNER, UserRole.SALON_STAFF],
  [UserRole.SALON_OWNER]: [UserRole.SALON_STAFF],
  [UserRole.SALON_STAFF]: [], // staff cannot invite anyone
};

function assertCanInviteRole(inviterRole: UserRole, requestedRole: UserRole): void {
  if (!ROLES_INVITABLE_BY[inviterRole].includes(requestedRole)) {
    throw new InviteRoleNotAllowedError(inviterRole, requestedRole);
  }
}

// ─────────────────────────────────────────────
// CREATE INVITE
// ─────────────────────────────────────────────

export async function createInvite(params: {
  email: string;
  role: UserRole;
  salonId: string;
  invitedByUserId: string;
  invitedByRole: UserRole;
}): Promise<{ inviteId: string; email: string; role: UserRole; expiresAt: Date; rawToken: string }> {
  assertCanInviteRole(params.invitedByRole, params.role);

  const existingUser = await prisma.user.findUnique({ where: { email: params.email } });
  if (existingUser) {
    throw new InviteEmailAlreadyRegisteredError(params.email);
  }

  const { rawToken, tokenHash } = generateInviteToken();
  const expiresAt = computeInviteExpiry();

  const invite = await prisma.userInvite.create({
    data: {
      email: params.email,
      tokenHash,
      role: params.role,
      status: InviteStatus.PENDING,
      expiresAt,
      salonId: params.salonId,
      invitedByUserId: params.invitedByUserId,
    },
  });

  log.info(
    { inviteId: invite.id, email: params.email, role: params.role, invitedBy: params.invitedByUserId },
    'Invite created',
  );

  return { inviteId: invite.id, email: params.email, role: params.role, expiresAt, rawToken };
}

export function buildInviteUrl(rawToken: string): string {
  return `${ADMIN_PANEL_URL}/accept-invite?token=${rawToken}`;
}

// ─────────────────────────────────────────────
// ACCEPT INVITE
// ─────────────────────────────────────────────

export async function acceptInvite(params: {
  rawToken: string;
  password: string;
  name: string;
}): Promise<{ id: string; email: string; role: UserRole; salonId: string | null }> {
  const tokenHash = hashInviteToken(params.rawToken);

  const invite = await prisma.userInvite.findUnique({ where: { tokenHash } });

  if (!invite || invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date()) {
    throw new InviteTokenInvalidError();
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existingUser) {
    throw new InviteEmailAlreadyRegisteredError(invite.email);
  }

  // Step 1: create the Supabase Auth user.
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password: params.password,
    email_confirm: true, // invite link itself is the verification step
    user_metadata: { name: params.name },
  });

  if (authError || !authData.user) {
    log.error({ err: authError, email: invite.email }, 'Failed to create Supabase auth user during invite acceptance');
    throw new Error('Failed to create account. Please try again or contact support.');
  }

  // Step 2: create our User row. If this fails, roll back the Supabase
  // user so a retry doesn't hit "email already registered" on a
  // half-completed acceptance.
  try {
    const user = await prisma.user.create({
      data: {
        supabaseUserId: authData.user.id,
        email: invite.email,
        name: params.name,
        role: invite.role,
        salonId: invite.salonId,
        isActive: true,
      },
    });

    await prisma.userInvite.update({
      where: { id: invite.id },
      data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
    });

    log.info({ userId: user.id, email: user.email, role: user.role }, 'Invite accepted, account created');

    return { id: user.id, email: user.email, role: user.role, salonId: user.salonId };
  } catch (dbError) {
    log.error(
      { err: dbError, supabaseUserId: authData.user.id },
      'Failed to create local User row after Supabase user creation — attempting rollback',
    );
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch((cleanupErr) => {
      log.error(
        { err: cleanupErr, supabaseUserId: authData.user.id },
        'Rollback of orphaned Supabase auth user also failed — manual cleanup required',
      );
    });
    throw dbError;
  }
}

// ─────────────────────────────────────────────
// TEAM ROSTER
// ─────────────────────────────────────────────

export async function listTeam(salonId: string) {
  return prisma.user.findMany({
    where: { salonId, isActive: true },
    select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}
