/**
 * src/lib/logger.ts
 *
 * Structured logger built on pino.
 *
 * WHY PINO:
 * Winston and console.log produce string output that is slow to parse
 * and impossible to query in BetterStack or Datadog. Pino emits newline-
 * delimited JSON by default, which log aggregators can index field-by-field.
 * This means "show me all failed message sends for salonId X in the last
 * hour" becomes a 2-second query, not a grep session.
 *
 * CHILD LOGGERS:
 * Every module creates a child logger with its module name as a field.
 * This means every log line carries { module: 'booking.service' } automatically,
 * allowing filtering without parsing the message string.
 *
 * USAGE:
 *   import { logger } from '@/lib/logger';
 *
 *   // Module-level child (do this once per file, at the top)
 *   const log = logger.child({ module: 'booking.service' });
 *
 *   // Structured logging — always pass context as the first argument
 *   log.info({ bookingId, customerId }, 'Booking confirmed');
 *   log.error({ err, bookingId }, 'Slot claim failed');
 *
 *   // NEVER do this — unstructured, unsearchable
 *   log.info(`Booking ${bookingId} confirmed for customer ${customerId}`);
 */

import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';

export const logger = pino({
  // In test environments, suppress all log output to keep test output clean.
  // Tests that need to assert on log output can create their own logger instance.
  level: isTest ? 'silent' : isDevelopment ? 'debug' : 'info',

  // Pretty-print in development for human readability.
  // In production, emit raw JSON for log aggregators.
  transport: isDevelopment
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,

  // Base fields on every log line in production
  base: {
    service: 'theslotbot-api',
    env: process.env.NODE_ENV,
  },

  // Serialize Error objects — pino doesn't do this by default
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },

  // ISO 8601 timestamps with timezone
  timestamp: pino.stdTimeFunctions.isoTime,
});
