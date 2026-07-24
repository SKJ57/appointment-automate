/**
 * src/lib/redis.ts
 *
 * Redis connection factory for BullMQ.
 *
 * WHY TWO CONNECTIONS:
 * BullMQ requires separate Redis connections for the Queue (producer)
 * and the Worker (consumer) because the worker uses BLPOP/SUBSCRIBE
 * which blocks the connection. A single shared connection would starve
 * queue operations while the worker is blocking.
 *
 * BullMQ also requires the connection object itself (ioredis instance),
 * not just a URL string. This factory gives BullMQ exactly what it needs.
 *
 * CONNECTION OPTIONS:
 * - maxRetriesPerRequest: null  → Required by BullMQ. Without this, ioredis
 *   throws on reconnect attempts and BullMQ jobs fail permanently on
 *   transient Redis blips.
 * - enableReadyCheck: false     → Required by BullMQ for the same reason.
 * - retryStrategy              → Exponential backoff capped at 10s.
 *   Prevents hammering a Redis instance that's restarting.
 *
 * USAGE:
 *   import { getBullMQConnection } from '@/lib/redis';
 *   const queue = new Queue('reminders', { connection: getBullMQConnection() });
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error('REDIS_URL environment variable is not set');
}

function createRedisConnection(name: string): Redis {
  const client = new Redis(REDIS_URL!, {
    // Required by BullMQ — without these, ioredis throws on reconnect
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    // Exponential backoff: 100ms → 200ms → 400ms → ... → 10s
    retryStrategy(times) {
      const delay = Math.min(100 * Math.pow(2, times), 10_000);
      return delay;
    },

    // Identifies this connection in Redis CLIENT LIST output
    // Useful for debugging connection pool exhaustion
    connectionName: `theslotbot-${name}`,
  });

  client.on('error', (err) => {
    // Log but don't throw — ioredis handles reconnection automatically
    console.error(`[Redis:${name}] Connection error:`, err.message);
  });

  client.on('connect', () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Redis:${name}] Connected`);
    }
  });

  return client;
}

// Two separate connections: one for queue producers, one for workers.
// BullMQ creates its own internal connections from these when needed —
// we hand it the factory function, not a shared instance.
let _queueConnection: Redis | null = null;
let _workerConnection: Redis | null = null;

export function getBullMQConnection(): Redis {
  if (!_queueConnection) {
    _queueConnection = createRedisConnection('queue');
  }
  return _queueConnection;
}

export function getWorkerConnection(): Redis {
  if (!_workerConnection) {
    _workerConnection = createRedisConnection('worker');
  }
  return _workerConnection;
}

/**
 * Close all Redis connections gracefully.
 * Called in the server shutdown handler (SIGTERM/SIGINT).
 */
export async function closeRedisConnections(): Promise<void> {
  const closures: Promise<void>[] = [];

  if (_queueConnection) {
    closures.push(_queueConnection.quit().then(() => { _queueConnection = null; }));
  }
  if (_workerConnection) {
    closures.push(_workerConnection.quit().then(() => { _workerConnection = null; }));
  }

  await Promise.all(closures);
}
