/**
 * src/workers/index.ts
 *
 * Entrypoint for the WORKER process — deployed and scaled separately
 * from the API server (src/index.ts), per the architecture's node
 * separation principle (Section 2.3 of the original spec): a burst of
 * scheduled campaign messages must never starve the responsiveness of
 * live customer conversations, which means the process handling
 * BullMQ jobs cannot be the same process handling inbound webhook
 * traffic under load.
 *
 * DEPLOYMENT:
 * Railway/Render: a second service in the same project, same repo,
 * different start command (`pnpm start:workers` instead of `pnpm start`).
 * Both processes share the same DATABASE_URL and REDIS_URL.
 *
 * WHAT RUNS HERE:
 *   - reminderWorker       (consumes the `reminders` queue — imported
 *                            for its side effect of starting the BullMQ
 *                            Worker, which begins processing immediately
 *                            on construction)
 *   - campaignWorker       (consumes the `revisit-campaign` queue;
 *                            also exposes runDailyCampaignSweep() for
 *                            the daily schedule registered below)
 *   - reviewWorker         (Phase 4 — not yet implemented; the
 *                            `review-requests` queue exists in queues.ts
 *                            but has no consumer yet)
 *   - offlineMessageWorker (Phase 4 — the ghost-rule send itself is
 *                            currently synchronous inside subscriptionGate,
 *                            not queue-driven; offlineMessageQueue is
 *                            defined in queues.ts for future use if
 *                            that changes)
 *
 * DAILY CAMPAIGN TRIGGER:
 * BullMQ's repeatable-jobs feature schedules a sweep trigger once per
 * day. We register that schedule here at process startup rather than
 * via an external cron service, keeping the scheduling logic inside
 * the same codebase as the logic it triggers.
 */

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { closeRedisConnections } from '@/lib/redis';
import { closeAllQueues, revisitCampaignQueue } from './queues';
import { reminderWorker } from './reminder.worker';
import { campaignWorker, runDailyCampaignSweep } from './campaign.worker';

const log = logger.child({ module: 'workers.index' });

// ─────────────────────────────────────────────
// DAILY CAMPAIGN SCHEDULE
//
// Registers a BullMQ repeatable job that enqueues a campaign-sweep
// trigger once per day at 09:00. campaignWorker (constructed on import
// above) picks up that job and calls runDailyCampaignSweep().
//
// NOTE: the repeatable job's cron expression runs in the BullMQ/Redis
// scheduler's own clock (effectively server/UTC time), not salon-local
// time. 09:00 here is a deliberately mid-morning trigger chosen to
// comfortably clear quiet-hours windows across realistic salon
// timezones. The real correctness guarantee is per-message: each send
// inside the sweep still goes through the gateway, and any individual
// message landing in quiet hours is handled by that send path, not by
// this schedule time. This timestamp is a coarse optimization, not a
// load-bearing safety mechanism.
// ─────────────────────────────────────────────

async function registerDailyCampaignSchedule(): Promise<void> {
  await revisitCampaignQueue.add(
    'daily-sweep',
    {},
    {
      jobId: 'daily-campaign-sweep', // stable ID prevents duplicate schedules across restarts
      repeat: { pattern: '0 9 * * *' }, // every day at 09:00
    },
  );
  log.info('Daily campaign sweep schedule registered');
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

async function start(): Promise<void> {
  log.info('Worker process starting');

  // reminderWorker and campaignWorker are BullMQ Worker instances —
  // importing them above already constructs and starts them; there is
  // no separate .start() call in the BullMQ API. This function's job
  // is purely to register the one-time daily schedule.
  await registerDailyCampaignSchedule();

  log.info('Worker process ready — reminderWorker and campaignWorker are listening');
}

start().catch((err) => {
  log.error({ err }, 'Worker process failed to start');
  process.exit(1);
});

// Exported for local dev tooling / a future admin "run campaign now" action
export { runDailyCampaignSweep };

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Worker shutdown signal received');

  try {
    await Promise.all([reminderWorker.close(), campaignWorker.close()]);
    await closeAllQueues();
    await closeRedisConnections();
    await prisma.$disconnect();
    log.info('Worker graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
