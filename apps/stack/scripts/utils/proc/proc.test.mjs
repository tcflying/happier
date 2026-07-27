import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  killProcessTree,
  markSpawnedProcessPlannedExit,
  resolveRuntimeTeePath,
  runCapture,
  runCaptureResult,
  spawnProc,
} from './proc.mjs';
import { resolveDefaultShellForCommand } from './proc.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'happy-proc-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('killProcessTree delegates Windows cleanup to the canonical bounded tree-termination owner', async () => {
  let taskkillStarted = 0;
  const result = await killProcessTree({ pid: 4242, kill: () => true }, 'SIGTERM', {
    boundary: {
      platform: 'win32',
      isPidAlive: () => false,
      spawn: () => {
        taskkillStarted += 1;
        throw new Error('taskkill must not start after the liveness owner rejects the pid');
      },
    },
  });

  assert.equal(taskkillStarted, 0);
  assert.equal(result.ok, false);
});

test('killProcessTree fails closed for an already-exited Windows child', async () => {
  const result = await killProcessTree({ pid: 4243, exitCode: 0 }, 'SIGTERM', {
    boundary: { platform: 'win32' },
  });
  assert.deepEqual(result, { ok: false, reason: 'leader_absent_without_tree_proof' });
});

test('spawnProc completion exposes the pipe and tee drain boundary', async (t) => {
  const root = await withTempRoot(t);
  const child = spawnProc('completion', process.execPath, ['-e', 'console.log("done")'], {
    ...process.env,
    HAPPIER_STACK_LOG_TEE_DIR: root,
  }, {
    silent: true,
    teeFile: join(root, 'completion.log'),
  });
  const outcome = await child.completion;
  assert.equal(outcome.code, 0);
  assert.match(await readFile(join(root, 'completion.log'), 'utf8'), /\[completion\] done/);
});

test('runCapture supports aborting a long-running command', async () => {
  const controller = new AbortController();
  const pending = runCapture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, (error) => error?.code === 'ABORT_ERR');
});

test('spawnProc marks a planned exit without hiding its nonzero outcome', async (t) => {
  const stderr = [];
  t.mock.method(process.stderr, 'write', (line) => { stderr.push(String(line)); return true; });
  const child = spawnProc('planned', process.execPath, ['-e', 'process.exit(1)'], process.env);
  markSpawnedProcessPlannedExit(child, 'dev-reload');
  const outcome = await child.completion;
  assert.equal(outcome.code, 1);
  assert.match(stderr.join(''), /planned dev-reload exit/);
});

test('runCaptureResult captures stdout/stderr', async () => {
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.out, /hello/);
  assert.match(res.err, /oops/);
});

test('runCaptureResult streams output when streamLabel is set (without affecting captured output)', async (t) => {
  const root = await withTempRoot(t);
  const stdoutWrites = [];
  const stderrWrites = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, 'write', (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: root },
    streamLabel: 'proc-test',
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.out, /hello/);
  assert.match(res.err, /oops/);

  const streamedOut = stdoutWrites.join('');
  const streamedErr = stderrWrites.join('');
  assert.match(streamedOut, /\[proc-test\] hello/);
  assert.match(streamedErr, /\[proc-test\] oops/);
});

test('runCaptureResult can tee streamed output to a file', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'tee.log');
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: root },
    teeFile,
    teeLabel: 'tee-test',
  });
  assert.equal(res.ok, true);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[tee-test\] hello/);
  assert.match(raw, /\[tee-test\] oops/);
});

test('runCaptureResult preserves an explicit structured artifact path', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'review-run', 'raw', 'review.log');
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("review")'], {
    env: {
      ...process.env,
      HAPPIER_STACK_LOG_TEE_DIR: join(root, 'central-runtime-logs'),
    },
    teeFile,
    teeLabel: 'review',
  });
  assert.equal(res.ok, true);
  assert.match(await readFile(teeFile, 'utf8'), /\[review\] review/);
});

test('runCaptureResult emits periodic keepalive logs while process is running', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'keepalive.log');
  const res = await runCaptureResult(
    process.execPath,
    ['-e', 'setTimeout(() => { process.exit(0); }, 220);'],
    {
      env: { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: root },
      cwd: root,
      teeFile,
      teeLabel: 'keepalive-test',
      heartbeatMs: 50,
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[keepalive-test\] still running \(elapsed \d+s, pid=\d+\)/);
});

test('spawnProc can tee output to an env-scoped tee dir when no explicit teeFile is provided', async (t) => {
  const root = await withTempRoot(t);
  const teeDir = join(root, 'tee');
  const env = { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: teeDir };

  const child = spawnProc('server', process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], env, {
    silent: true,
  });
  await new Promise((resolve) => child.on('exit', resolve));

  const raw = await readFile(join(teeDir, 'server.log'), 'utf-8');
  assert.match(raw, /\[server\] hello/);
  assert.match(raw, /\[server\] oops/);
});

test('spawnProc reports complete stdout and stderr lines to onLine', async (t) => {
  const root = await withTempRoot(t);
  const observed = [];
  const child = spawnProc(
    'line-test',
    process.execPath,
    [
      '-e',
      [
        "process.stdout.write('one\\npa');",
        "setTimeout(() => { process.stdout.write('rt\\n'); process.stderr.write('err\\n'); }, 25);",
      ].join(''),
    ],
    { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: root },
    {
      silent: true,
      onLine: (event) => observed.push(event),
    }
  );

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    child.on('error', reject);
  });

  assert.deepEqual(observed, [
    { stream: 'stdout', line: 'one' },
    { stream: 'stdout', line: 'part' },
    { stream: 'stderr', line: 'err' },
  ]);
});

test('resolveRuntimeTeePath relocates repo-root logs into a trusted project log directory', async (t) => {
  const root = await withTempRoot(t);
  const requested = join(root, 'happier-runtime.log');
  const actual = resolveRuntimeTeePath({
    label: 'runtime',
    teeFile: requested,
    env: {},
    cwd: root,
  });

  assert.equal(actual, join(root, '.project', 'logs', 'happier-runtime.log'));
});

test('resolveRuntimeTeePath preserves paths inside an explicit trusted log directory', async (t) => {
  const root = await withTempRoot(t);
  const logRoot = join(root, 'central-logs');
  const requested = join(logRoot, 'runtime.log');
  const actual = resolveRuntimeTeePath({
    label: 'runtime',
    teeFile: requested,
    env: { HAPPIER_STACK_LOG_TEE_DIR: logRoot },
    cwd: root,
  });

  assert.equal(actual, requested);
});

test('resolveDefaultShellForCommand enables a shell for Yarn shims on Windows', () => {
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('yarn.cmd', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('git', { platform: 'win32' }), false);
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'linux' }), false);
});
