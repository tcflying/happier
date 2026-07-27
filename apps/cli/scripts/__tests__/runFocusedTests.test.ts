import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFocusedVitestInvocation } from '../runFocusedTests.mjs';

describe('runFocusedTests', () => {
  it('requires an explicit test file selector', () => {
    expect(() => createFocusedVitestInvocation({
      argv: ['-t', 'only this test'],
      cliRoot: resolve('fixture', 'repo', 'apps', 'cli'),
      runRoot: resolve('fixture', 'temp', 'focused-run'),
    })).toThrow(/explicit .*test file/i);
  });

  it('isolates Vitest cache, reports, and temporary files from live services', () => {
    const cliRoot = resolve('fixture', 'repo', 'apps', 'cli');
    const repoRoot = resolve(cliRoot, '..', '..');
    const runRoot = resolve('fixture', 'temp', 'focused-run');
    const invocation = createFocusedVitestInvocation({
      argv: ['src/test-setup.test.ts', '-t', 'focused-test mode'],
      cliRoot,
      runRoot,
      execPath: resolve('fixture', 'node', 'node.exe'),
      env: {
        HAPPIER_CLI_TEST_SKIP_BUILD: 'true',
        KEEP_ME: 'yes',
      },
    });

    expect(invocation.args).toEqual([
      join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      join(cliRoot, 'vitest.focused.config.ts'),
      'src/test-setup.test.ts',
      '-t',
      'focused-test mode',
    ]);
    expect(invocation.env).toMatchObject({
      HAPPIER_CLI_FOCUSED_TEST_RUN_DIR: runRoot,
      TMPDIR: join(runRoot, 'tmp'),
      TMP: join(runRoot, 'tmp'),
      TEMP: join(runRoot, 'tmp'),
      KEEP_ME: 'yes',
    });
    expect(invocation.env.HAPPIER_CLI_TEST_SKIP_BUILD).toBeUndefined();
  });
});
