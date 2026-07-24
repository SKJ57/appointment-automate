/**
 * src/api/routes/services.ts
 *
 * Not explicitly requested in any prior phase brief, but WalkInForm.tsx
 * (this phase) needs a service dropdown to exist at all, and there was
 * no endpoint to populate it. Same category of necessary addition as
 * /auth/me in Phase 4 — flagging it rather than quietly filling the gap.
 */

import { Router, Request, Response } from 'express';
import { UserRole } from '@theslotbot/shared/types';
import { requireAuth, requireRole } from '@/api/middleware/authMiddleware';
import { sendSuccess, handleRouteError } from '@/api/respond';
import { getCurrentSalonId } from '@/lib/currentSalon';
import { toServiceDto } from '@/api/serializers';
import { prisma } from '@/lib/prisma';

export const servicesRouter = Router();

servicesRouter.use(requireAuth, requireRole(UserRole.SALON_STAFF, UserRole.SALON_OWNER));

servicesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const salonId = await getCurrentSalonId();

    const services = await prisma.service.findMany({
      where: { salonId, isActive: true },
      orderBy: { displayOrder: 'asc' },
    });

    sendSuccess(res, services.map(toServiceDto));
  } catch (err) {
    handleRouteError(res, err);
  }
});
