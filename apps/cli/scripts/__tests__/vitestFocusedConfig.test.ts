import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFocusedVitestConfig } from '../../vitest.focused.config.shared';

describe('focused Vitest config', () => {
  it('puts cache and reports in the unique focused-test run directory', () => {
    const runRoot = resolve('fixture', 'focused-run');
    const config = createFocusedVitestConfig({
      test: {
        environment: 'node',
        coverage: { provider: 'v8' },
      },
    }, runRoot);

    expect(config.cacheDir).toBe(join(runRoot, 'vite-cache'));
    expect(config.test?.globalSetup).toEqual(['./src/test-setup.focused.ts']);
    expect(config.test?.coverage?.reportsDirectory).toBe(join(runRoot, 'coverage'));
  });

  it('exposes the live-service-safe runner as a package command', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['test:focused']).toBe('node scripts/runFocusedTests.mjs');
  });
});
