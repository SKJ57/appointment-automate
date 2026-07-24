/**
 * src/lib/prisma.ts
 *
 * Prisma client singleton.
 *
 * WHY A SINGLETON:
 * Prisma Client maintains a connection pool internally. Importing
 * `new PrismaClient()` in multiple modules creates multiple pools,
 * which exhausts database connections quickly under load and in
 * development hot-reload cycles (where modules re-evaluate on save).
 *
 * This pattern is the official Prisma recommendation for Next.js and
 * Node.js applications. The global cache trick prevents duplicate
 * instances during ts-node-dev hot reloads in development.
 *
 * USAGE:
 *   import { prisma } from '@/lib/prisma';
 *   const bookings = await prisma.booking.findMany(...);
 *
 * Never instantiate PrismaClient anywhere else in the codebase.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
