import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 180_000,
    globalSetup: ['tests/helpers/global-setup.ts'],
    // DB-backed suites share one Postgres cluster but each get their own
    // database, so parallel files are safe.
    pool: 'forks',
  },
});
