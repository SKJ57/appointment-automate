import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Sequential execution for repository tests — they share a single
    // test database and rely on beforeEach creating isolated fixtures
    // (unique salon per test), but running too many DB transactions
    // in parallel against a small CI Postgres instance can exhaust
    // connections. Pool size tuning can revisit this once the test
    // suite grows.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    testTimeout: 15_000, // concurrency tests involve real transactions
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@theslotbot/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
