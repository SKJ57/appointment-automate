/**
 * src/modules/auth/inviteToken.ts
 *
 * Invite tokens are high-entropy random strings, not passwords — the
 * threat model is "can someone guess a valid token by brute force,"
 * not "can someone crack a weak human-chosen secret." A 256-bit random
 * token hashed with SHA-256 is the standard pattern for this class of
 * credential (the same approach GitHub, Stripe, and most API-key
 * systems use for verification/reset tokens) — bcrypt's deliberate
 * slowness exists to defend against offline dictionary attacks on
 * low-entropy secrets, which doesn't apply here and would only add
 * unnecessary latency to every invite-acceptance request.
 *
 * The raw token is transmitted exactly once, in the invite URL. Only
 * its SHA-256 hash is ever persisted. This mirrors the same
 * idempotency-key-style hashing already used elsewhere in this
 * codebase (message-log.service.ts), for consistency.
 */

import crypto from 'crypto';

const INVITE_EXPIRY_HOURS = 72;

export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashInviteToken(rawToken);
  return { rawToken, tokenHash };
}

export function hashInviteToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function computeInviteExpiry(): Date {
  return new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
}
