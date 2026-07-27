import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE_SELECTOR_PATTERN = /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function assertExplicitTestFile(argv) {
  if (argv.some((argument) => TEST_FILE_SELECTOR_PATTERN.test(argument))) return;
  throw new Error(
    'Focused CLI tests require an explicit *.test.* or *.spec.* test file argument.',
  );
}

export function createFocusedVitestInvocation({
  argv,
  cliRoot,
  runRoot,
  execPath = process.execPath,
  env = process.env,
}) {
  assertExplicitTestFile(argv);

  const repoRoot = resolve(cliRoot, '..', '..');
  const tempDir = join(runRoot, 'tmp');
  const childEnv = {
    ...env,
    HAPPIER_CLI_FOCUSED_TEST_RUN_DIR: runRoot,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
  delete childEnv.HAPPIER_CLI_TEST_SKIP_BUILD;

  return {
    command: execPath,
    args: [
      join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      join(cliRoot, 'vitest.focused.config.ts'),
      ...argv,
    ],
    cwd: cliRoot,
    env: childEnv,
    tempDir,
  };
}

export function runFocusedTests(argv = process.argv.slice(2)) {
  assertExplicitTestFile(argv);

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptsDir, '..');
  const runRoot = mkdtempSync(join(tmpdir(), 'happier-cli-focused-'));
  const invocation = createFocusedVitestInvocation({ argv, cliRoot, runRoot });
  mkdirSync(invocation.tempDir, { recursive: true });

  try {
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(runRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  try {
    process.exitCode = runFocusedTests();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Focused CLI test failed: ${message}`);
    process.exitCode = 1;
  }
}
