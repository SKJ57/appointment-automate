/**
 * src/lib/currentSalon.ts
 *
 * WHITE-LABEL ARCHITECTURE CONSEQUENCE:
 * Per the clone-and-deploy model, each running instance of this codebase
 * serves exactly one Salon. The database contains exactly one Salon row
 * (seeded by prisma/seeds/index.ts). Admin API routes therefore never
 * need to accept or trust a client-supplied salonId — doing so would
 * open a class of bugs (and, if this pattern were ever mistakenly reused
 * in a multi-tenant context, a cross-tenant data leak) for no benefit,
 * since there is only ever one correct answer.
 *
 * This resolver looks up that one Salon by CLIENT_CONFIG.salon.slug and
 * memoizes the result in-process. The memo is intentionally simple (no
 * TTL) because the Salon row's identity (id, slug) never changes after
 * seeding — only mutable fields like subscriptionStatus change, and
 * those are read fresh wherever they matter (e.g. subscriptionGate
 * queries the Salon row directly rather than trusting this cache for
 * anything beyond the id/name).
 */

import { prisma } from '@/lib/prisma';
import { CLIENT_CONFIG } from '@/config/client.config';

let cachedSalonId: string | null = null;

export class SalonNotSeededError extends Error {
  constructor(slug: string) {
    super(
      `No Salon row found for slug '${slug}'. Run 'pnpm db:seed' before starting the API server.`,
    );
    this.name = 'SalonNotSeededError';
  }
}

/**
 * Returns the id of the single Salon this deployment serves.
 * Throws SalonNotSeededError if the seed script has not been run yet —
 * this is a startup-time configuration error, not a normal runtime
 * condition, so routes should let it propagate to the global error
 * handler rather than catching it locally.
 */
export async function getCurrentSalonId(): Promise<string> {
  if (cachedSalonId) return cachedSalonId;

  const salon = await prisma.salon.findUnique({
    where: { slug: CLIENT_CONFIG.salon.slug },
    select: { id: true },
  });

  if (!salon) {
    throw new SalonNotSeededError(CLIENT_CONFIG.salon.slug);
  }

  cachedSalonId = salon.id;
  return cachedSalonId;
}

/** Test-only escape hatch to reset the memo between test suites. */
export function _resetCurrentSalonCache(): void {
  cachedSalonId = null;
}
