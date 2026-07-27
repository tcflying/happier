import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  runMetroWindowsHmrSoak,
  selectProcessTree,
} from './metroWindowsHmrSoak.mjs';

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('process-tree snapshots exclude a stale child whose PID parent was reused', () => {
  const rows = [
    { pid: 100, parentPid: 1, name: 'chrome.exe', createdAtMs: 2000 },
    { pid: 101, parentPid: 100, name: 'chrome.exe', createdAtMs: 2100 },
    { pid: 102, parentPid: 101, name: 'git.exe', createdAtMs: 1000 },
  ];

  assert.deepEqual(
    selectProcessTree(rows, 100).map((entry) => entry.pid),
    [100, 101],
  );
});

test('records the real Metro exit and writes a terminal failure without waiting for page timeout', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'happier-hmr-harness-test-'));
  context.after(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  const artifactPath = join(outputRoot, 'artifact.json');
  const logPath = join(outputRoot, 'metro.log');
  const metro = createFakeChild(41_001);
  let metroInvocation = null;
  let browserKillCalls = 0;
  const page = new EventEmitter();
  page.goto = () => {
    queueMicrotask(() => {
      metro.stderr.write(
        'TypeError: The "paths[1]" argument must be of type string. Received null\n',
      );
      metro.exitCode = 1;
      metro.emit('exit', 1, null);
      metro.stderr.end();
      metro.stdout.end();
      metro.emit('close', 1, null);
    });
    return new Promise(() => {});
  };
  page.waitForFunction = async () => {
    throw new Error('waitForFunction must not run after Metro exits');
  };

  const startedAtMs = Date.now();
  const artifact = await runMetroWindowsHmrSoak({
    options: {
      artifactPath,
      durationMs: 120_000,
      handleBudget: 50_000,
      logPath,
      pagesCount: 2,
      port: 19_321,
      updateIntervalMs: 15_000,
    },
    dependencies: {
      captureProcessTree: () => ({
        rootPid: metro.pid,
        sampledAt: new Date().toISOString(),
        processes: [],
      }),
      fetch: async () => ({
        ok: true,
        status: 200,
        body: { cancel: async () => {} },
      }),
      launchBrowser: async () => ({
        browser: {
          close: () => new Promise(() => {}),
          newPage: async () => page,
        },
        browserPid: 41_002,
        kill: async () => {
          browserKillCalls += 1;
        },
      }),
      sleep: (milliseconds) => new Promise((resolvePromise) => {
        setTimeout(resolvePromise, Math.min(milliseconds, 1));
      }),
      spawnMetro: (invocation) => {
        metroInvocation = invocation;
        return metro;
      },
      stopProcessTree: () => ({
        requested: false,
        reason: 'already_exited',
      }),
    },
  });
  const operationElapsedMs = Date.now() - startedAtMs;

  assert.ok(operationElapsedMs < 3_000, `harness took ${operationElapsedMs}ms`);
  assert.ok(metroInvocation);
  const tempPathFromMarkerRoot = relative(
    metroInvocation.env.HAPPIER_UI_HMR_SOAK_ROOT,
    metroInvocation.env.TEMP,
  );
  assert.ok(
    tempPathFromMarkerRoot.startsWith('..') || isAbsolute(tempPathFromMarkerRoot),
    'Metro TEMP must stay outside the watched HMR marker root',
  );
  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.serverLogPath, logPath);
  assert.equal(artifact.metroExit.event, 'exit');
  assert.equal(artifact.metroExit.code, 1);
  assert.equal(artifact.metroExit.signal, null);
  assert.equal(browserKillCalls, 0);
  assert.equal(artifact.browserCleanup.close.status, 'timed_out');
  assert.equal(artifact.browserCleanup.kill.status, 'not_needed');
  assert.equal(artifact.browserCleanup.processTree.exited, true);
  assert.equal(artifact.processTree.exited, true);
  assert.equal(artifact.processTree.afterCleanup.processes.length, 0);
  assert.match(artifact.failure.message, /Metro exited during browser_navigation/u);
  assert.match(artifact.failure.metroOutputTail, /paths\[1\].*Received null/u);
  assert.doesNotMatch(artifact.failure.message, /ERR_CONNECTION_REFUSED/u);

  const persistedArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  assert.equal(persistedArtifact.status, 'failed');
  assert.ok(persistedArtifact.finishedAt);
  assert.match(
    await readFile(logPath, 'utf8'),
    /TypeError: The "paths\[1\]" argument must be of type string\. Received null/u,
  );
});

test('aborts a hung browser navigation and writes a terminal artifact', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'happier-hmr-harness-abort-test-'));
  context.after(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  const artifactPath = join(outputRoot, 'artifact.json');
  const logPath = join(outputRoot, 'metro.log');
  const metro = createFakeChild(43_001);
  const controller = new AbortController();
  const page = new EventEmitter();
  page.goto = () => {
    controller.abort();
    return new Promise(() => {});
  };
  page.waitForFunction = async () => {
    throw new Error('waitForFunction must not run after aborting navigation');
  };

  const artifact = await runMetroWindowsHmrSoak({
    options: {
      artifactPath,
      cleanupSettleMs: 1,
      durationMs: 90_000,
      handleBudget: 50_000,
      logPath,
      pagesCount: 1,
      port: 19_323,
      processCloseTimeoutMs: 1,
      updateIntervalMs: 15_000,
    },
    dependencies: {
      abortSignal: controller.signal,
      captureProcessTree: () => ({
        rootPid: metro.pid,
        sampledAt: new Date().toISOString(),
        processes: [],
      }),
      fetch: async () => ({
        ok: true,
        status: 200,
        body: { cancel: async () => {} },
      }),
      launchBrowser: async () => ({
        browser: {
          close: async () => {},
          newPage: async () => page,
        },
      }),
      sleep: (milliseconds) => new Promise((resolvePromise) => {
        setTimeout(resolvePromise, Math.min(milliseconds, 1));
      }),
      spawnMetro: () => metro,
      stopProcessTree: () => {
        metro.exitCode = 0;
        metro.emit('exit', 0, null);
        metro.emit('close', 0, null);
        return { requested: true, reason: 'test_abort_cleanup' };
      },
    },
  });

  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.stopReason, 'external_abort');
  assert.equal(artifact.failure.phase, 'browser_navigation');
  assert.ok(artifact.finishedAt);
  assert.equal(artifact.processTree.exited, true);
  const persistedArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  assert.equal(persistedArtifact.status, 'failed');
  assert.equal(persistedArtifact.failure.phase, 'browser_navigation');
});

test('writes complete when a timed-out browser close is followed by confirmed process exit', async (context) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'happier-hmr-harness-success-test-'));
  context.after(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  const artifactPath = join(outputRoot, 'artifact.json');
  const logPath = join(outputRoot, 'metro.log');
  const metro = createFakeChild(42_001);
  const browserPid = 42_002;
  const page = new EventEmitter();
  page.goto = async () => {};
  page.waitForFunction = async () => {};

  let clockMs = Date.now();
  let metroAlive = true;
  let browserAlive = true;
  const artifact = await runMetroWindowsHmrSoak({
    options: {
      artifactPath,
      browserCloseTimeoutMs: 1,
      browserKillTimeoutMs: 1,
      cleanupSettleMs: 1,
      durationMs: 20,
      handleBudget: 50_000,
      logPath,
      pagesCount: 1,
      port: 19_322,
      processCloseTimeoutMs: 1,
      updateIntervalMs: 1,
    },
    dependencies: {
      captureProcessTree: (rootPid) => {
        const alive = rootPid === metro.pid ? metroAlive : browserAlive;
        return {
          rootPid,
          sampledAt: new Date(clockMs).toISOString(),
          processes: alive
            ? [{
                pid: rootPid,
                parentPid: 1,
                name: rootPid === metro.pid ? 'node.exe' : 'chrome.exe',
                createdAtMs: rootPid === metro.pid ? 1000 : 2000,
              }]
            : [],
        };
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        body: { cancel: async () => {} },
      }),
      launchBrowser: async () => ({
        browser: {
          newPage: async () => page,
        },
        browserPid,
        close: () => new Promise(() => {}),
        kill: () => new Promise(() => {}),
      }),
      now: () => {
        clockMs += 1;
        return clockMs;
      },
      sampleProcess: () => ({ handleCount: 100 }),
      sleep: (milliseconds) => new Promise((resolvePromise) => {
        setTimeout(resolvePromise, Math.min(milliseconds, 1));
      }),
      spawnMetro: () => metro,
      stopProcessTree: (child) => {
        if (child.pid === browserPid) {
          browserAlive = false;
          return {
            requested: true,
            method: 'test_browser_tree_stop',
            status: 0,
            signal: null,
            error: null,
          };
        }
        metroAlive = false;
        metro.exitCode = 0;
        metro.emit('exit', 0, null);
        metro.emit('close', 0, null);
        return {
          requested: true,
          method: 'test_stop',
          status: 0,
          signal: null,
          error: null,
        };
      },
    },
  });

  assert.equal(artifact.browserCleanup.close.status, 'timed_out');
  assert.equal(artifact.browserCleanup.kill.status, 'not_needed');
  assert.equal(artifact.browserCleanup.fallbackStop.status, 0);
  assert.equal(artifact.browserCleanup.processTree.exited, true);
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.failure, null);

  const persistedArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  assert.equal(persistedArtifact.status, 'complete');
});
