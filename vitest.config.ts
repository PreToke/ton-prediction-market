import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@wrappers': path.resolve(__dirname, 'wrappers-ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['contracts/tests/**/*.test.ts'],
    testTimeout: 30_000, // TON sandbox tests can take a while
    pool: 'forks', // Isolate tests in separate processes for sandbox stability
    coverage: {
      provider: 'v8',
      include: ['wrappers-ts/**/*.ts', 'contracts/tests/**/*.ts'],
    },
  },
});
