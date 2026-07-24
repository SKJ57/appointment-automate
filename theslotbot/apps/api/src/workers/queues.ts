/**
 * src/workers/queues.ts
 *
 * BullMQ Queue definitions — the single source of truth for every queue
 * in the system. Workers and producers both import from here.
 *
 * ARCHITECTURE RULE:
 * Never instantiate a Queue or Worker anywhere else in the codebase.
 * All queue access goes through the exported instances below. This
 * prevents accidentally creating duplicate queue instances with
 * conflicting configuration.
 *
 * JOB ID STRATEGY (Risk C1 fix):
 * BullMQ deduplicates jobs with the same jobId within a queue. We use
 * deterministic, human-readable job IDs for all scheduled jobs so that:
 *   1. Duplicate webhook deliveries from Meta never create double jobs.
 *   2. A cancelled booking can remove its reminder jobs by known ID.
 *   3. The Redis keyspace is inspectable — you can look up a specific
 *      booking's reminder job without scanning the queue.
 *
 * Job ID formats:
 *   Reminder:         `reminder:${messageType}:${bookingId}`
 *   Review request:   `review:${bookingId}`
 *   Revisit campaign: `revisit:${messageType}:${customerId}:${date}`
 *   Offline message:  `offline:${salonId}:${phone}:${inboundMessageId}`
 *
 * RETENTION (from CLIENT_CONFIG.infra.jobRetentionMs):
 * Completed jobs are retained for 24h for debugging visibility.
 * Failed jobs are retained for 7d so we can inspect and replay them.
 */

import { Queue, QueueOptions } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
import { CLIENT_CONFIG } from '@/config/client.config';
import { QUEUE_NAMES } from '@theslotbot/shared/constants';
import type {
  ReminderJobPayload,
  ReviewRequestJobPayload,
  RevisitCampaignJobPayload,
  OfflineMessageJobPayload,
} from '@theslotbot/shared/types';

// ─── Shared Default Options ───────────────────────────────────────────────────

const defaultJobOptions: QueueOptions['defaultJobOptions'] = {
  // Retain completed and failed jobs for observability
  removeOnComplete: {
    age: CLIENT_CONFIG.infra.jobRetentionMs.completed / 1000, // BullMQ uses seconds
  },
  removeOnFail: {
    age: CLIENT_CONFIG.infra.jobRetentionMs.failed / 1000,
  },
  // Default retry config — overridden per job type where needed
  attempts: CLIENT_CONFIG.infra.messageQueue.maxRetries,
  backoff: {
    type: 'exponential',
    delay: CLIENT_CONFIG.infra.messageQueue.backoffBaseMs,
  },
};

function makeQueueOptions(): QueueOptions {
  return {
    connection: getBullMQConnection(),
    defaultJobOptions,
  };
}

// ─── Queue Instances ──────────────────────────────────────────────────────────

/**
 * Reminder queue: 24h and 3h pre-appointment reminders.
 * Jobs are delayed — they sit in queue until their fire time.
 * Each job has a deterministic ID: `reminder:${type}:${bookingId}`.
 * Cancelling a booking removes jobs by this ID.
 */
export const reminderQueue = new Queue<ReminderJobPayload>(
  QUEUE_NAMES.REMINDERS,
  makeQueueOptions(),
);

/**
 * Review request queue: post-visit thank-you + Google review link.
 * Jobs are delayed by CLIENT_CONFIG.review.requestDelayHours.
 * Each job has a deterministic ID: `review:${bookingId}`.
 */
export const reviewQueue = new Queue<ReviewRequestJobPayload>(
  QUEUE_NAMES.REVIEW_REQUESTS,
  makeQueueOptions(),
);

/**
 * Revisit campaign queue: Day 30 and Day 37 customer re-engagement.
 * Jobs are enqueued by the daily campaign cron, not on-demand.
 * Each job has a deterministic ID: `revisit:${type}:${customerId}:${date}`.
 */
export const revisitCampaignQueue = new Queue<RevisitCampaignJobPayload>(
  QUEUE_NAMES.REVISIT_CAMPAIGN,
  makeQueueOptions(),
);

/**
 * Offline message queue: service-suspended notifications.
 * Short-lived jobs — the 24h ghost rule is enforced in the worker
 * via OfflineMessageLog, not via BullMQ deduplication.
 */
export const offlineMessageQueue = new Queue<OfflineMessageJobPayload>(
  QUEUE_NAMES.OFFLINE_MESSAGES,
  makeQueueOptions(),
);

// ─── Job ID Builders ──────────────────────────────────────────────────────────
// Centralised here so producers and cancellation handlers use identical IDs.

export const JobId = {
  reminder: (messageType: string, bookingId: string) =>
    `reminder:${messageType}:${bookingId}`,

  review: (bookingId: string) =>
    `review:${bookingId}`,

  revisit: (messageType: string, customerId: string, date: string) =>
    `revisit:${messageType}:${customerId}:${date}`,

  offline: (salonId: string, phone: string, inboundMessageId: string) =>
    `offline:${salonId}:${phone}:${inboundMessageId}`,
} as const;

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

export async function closeAllQueues(): Promise<void> {
  await Promise.all([
    reminderQueue.close(),
    reviewQueue.close(),
    revisitCampaignQueue.close(),
    offlineMessageQueue.close(),
  ]);
}
