import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // Integration tests share Redis + Postgres; running files in parallel
    // would have them clobber each other's queue state. Serialize instead.
    fileParallelism: false,
  },
});
