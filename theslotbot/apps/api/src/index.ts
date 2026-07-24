/**
 * src/index.ts
 *
 * Express server entrypoint.
 *
 * CRITICAL MIDDLEWARE ORDERING (Risk E2):
 * The WhatsApp webhook route MUST receive the raw request body, not
 * JSON-parsed, so the signature middleware can compute an HMAC against
 * the exact bytes Meta sent. This means express.raw() is mounted ONLY
 * on the webhook route, registered BEFORE the global express.json()
 * middleware that every other route uses.
 *
 * If you ever need to add new webhook-style endpoints that require
 * signature validation against raw bytes, follow this same pattern:
 * mount express.raw() and the validator on that specific route path,
 * before the global JSON parser line.
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from '@/lib/logger';
import { CLIENT_CONFIG } from '@/config/client.config'; // validates on import — see config file
import { prisma } from '@/lib/prisma';
import { closeRedisConnections } from '@/lib/redis';
import { closeAllQueues } from '@/workers/queues';

import { validateWebhookSignature } from '@/api/middleware/validateWebhookSignature';
import { subscriptionGate } from '@/api/middleware/subscriptionGate';
import { whatsappWebhookRouter } from '@/api/routes/webhook/whatsapp';
import { bookingsRouter } from '@/api/routes/bookings';
import { slotsRouter } from '@/api/routes/slots';
import { adminDashboardRouter } from '@/api/routes/admin/dashboard';
import { adminReportsRouter } from '@/api/routes/admin/reports';
import { authRouter } from '@/api/routes/auth';
import { servicesRouter } from '@/api/routes/services';

const log = logger.child({ module: 'server' });

const app: Express = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
// Only the Admin Panel origin is allowed. The WhatsApp webhook route
// is server-to-server (Meta → us) and doesn't go through CORS at all —
// browsers aren't involved in that path.

app.use(
  cors({
    origin: process.env.ADMIN_PANEL_URL,
    credentials: true,
  }),
);

// ─────────────────────────────────────────────
// WEBHOOK ROUTE — raw body + signature validation + kill switch
// MUST be registered before the global express.json() below.
// ─────────────────────────────────────────────

app.use(
  '/api/webhook',
  express.raw({ type: 'application/json', limit: '5mb' }),
  validateWebhookSignature,
  subscriptionGate,
  whatsappWebhookRouter,
);

// ─────────────────────────────────────────────
// GLOBAL JSON PARSER — everything else (admin API routes, Phase 4+)
// ─────────────────────────────────────────────

app.use(express.json({ limit: '2mb' }));

// ─────────────────────────────────────────────
// HEALTH CHECK
// Used by Railway/Render for deploy health checks and by BetterStack
// for uptime monitoring. Deliberately does not touch the database —
// a DB blip shouldn't make the load balancer think the whole process
// is dead when it might just be a transient connection hiccup.
// ─────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// ADMIN API ROUTES
// Each router applies its own requireAuth + requireRole guards
// internally (see api/middleware/authMiddleware.ts), so no auth
// middleware is mounted at this level.
// ─────────────────────────────────────────────

app.use('/api/bookings', bookingsRouter);
app.use('/api/slots', slotsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/admin/dashboard', adminDashboardRouter);
app.use('/api/admin/reports', adminReportsRouter);
app.use('/api/auth', authRouter);

// Not yet implemented — later work:
// app.use('/api/customers', customersRouter);
// app.use('/api/admin/system', systemHealthRouter); // agency_admin only
// GET /api/auth/invite (list pending) and revoke — see auth.ts scope note

// ─────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
});

// ─────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// Catches anything thrown by route handlers that wasn't already
// caught and turned into a structured response. Express requires
// exactly this 4-arg signature to be recognised as an error handler.
// ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log.error({ err, path: req.path, method: req.method }, 'Unhandled error in request handler');

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' },
  });
});

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

const server = app.listen(PORT, () => {
  log.info(
    { port: PORT, env: process.env.NODE_ENV, salon: CLIENT_CONFIG.salon.name },
    'theslotbot API server started',
  );
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Railway/Render send SIGTERM before killing a container during
// deploys. We close BullMQ queues, Redis connections, and the Prisma
// connection pool cleanly so in-flight DB writes aren't abruptly cut.
// ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutdown signal received — closing connections gracefully');

  server.close(async () => {
    try {
      await closeAllQueues();
      await closeRedisConnections();
      await prisma.$disconnect();
      log.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  });

  // Force-exit if graceful shutdown hangs beyond a reasonable window
  setTimeout(() => {
    log.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
