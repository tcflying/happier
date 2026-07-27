import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('CLI unit lane live-service safety contract', () => {
  it('does not hide a shared rebuild in standard unit lifecycle scripts', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['test:unit']).toBe('node scripts/runUnitTestsLiveServiceSafe.mjs');
    expect(packageJson.scripts['test:unit:run']).not.toContain('build:shared');
    expect(packageJson.scripts.vitest).not.toContain('build:shared');
    expect(packageJson.scripts.pretest).toBeUndefined();
  });

  it('builds shared artifacts before the guarded unit command in CI', () => {
    const workflow = readFileSync(resolve('..', '..', '.github', 'workflows', 'tests.yml'), 'utf8');
    const cliJobStart = workflow.indexOf('  cli:');
    const buildStep = workflow.indexOf('yarn workspace @happier-dev/cli build:shared', cliJobStart);
    const unitStep = workflow.indexOf('yarn workspace @happier-dev/cli test:unit', cliJobStart);

    expect(cliJobStart).toBeGreaterThanOrEqual(0);
    expect(buildStep).toBeGreaterThan(cliJobStart);
    expect(unitStep).toBeGreaterThan(buildStep);
  });
});
