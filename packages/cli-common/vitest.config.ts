import { defineConfig } from 'vitest/config';

import { vitestMjsShebangPlugin } from '../../scripts/testing/vitestMjsShebangPlugin';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['tests/**/*.mjs', 'dist/**', 'node_modules/**'],
  },
  plugins: [vitestMjsShebangPlugin],
});
