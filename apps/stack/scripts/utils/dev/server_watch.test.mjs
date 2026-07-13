import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveStackOwnedServerListenPid, startDevServer, watchDevServerAndRestart } from './server.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-watch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

function createWatcherOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 34567,
    internalServerUrl: 'http://127.0.0.1:34567',
    serverScript: 'dev:light',
    serverEnv: {},
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'watch-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: process.pid, exitCode: null } },
    isShuttingDown: () => false,
    platform: 'linux',
    ...overrides,
  };
}

function createChangingSignatureReader() {
  let value = 0;
  return () => String(value++);
}

async function runWindowsWatcherChange(serverDir, {
  current = { pid: 100, exitCode: null },
  ancestryResults = [true, true],
  identityResults = [
    { pid: 100, creationDate: '20260713143000.000000+480' },
    { pid: 100, creationDate: '20260713143000.000000+480' },
    { pid: 201, creationDate: '20260713143001.000000+480' },
  ],
  runCaptureImpl = async () => '',
  waitForChildExitImpl = async () => true,
  isPidAliveImpl = () => true,
} = {}) {
  let capturedOnChange = null;
  let spawned = false;
  let spawnCalls = 0;
  const children = [current];
  const taskkillCalls = [];
  const ancestryChecks = [];
  const errors = [];
  const serverProcRef = { current };
  const identityQueue = [...identityResults];
  const ancestryQueue = [...ancestryResults];

  const watcher = watchDevServerAndRestart(
    createWatcherOptions(serverDir, { platform: 'win32', children, serverProcRef }),
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      killProcessGroupOwnedByStackImpl: async () => {
        throw new Error('Windows restart must not use POSIX marker/process-group ownership');
      },
      runCaptureImpl: async (...args) => {
        taskkillCalls.push(args);
        return await runCaptureImpl(...args);
      },
      waitForChildExitImpl,
      readWindowsProcessIdentityImpl: async () => identityQueue.shift() ?? null,
      isPidAliveImpl,
      waitForTcpPortFreeImpl: async () => true,
      pmSpawnScriptImpl: async () => {
        spawnCalls += 1;
        spawned = true;
        return { pid: 201, exitCode: null };
      },
      listListenPidsImpl: async () => (spawned ? [201] : [300]),
      isWindowsPidDescendantOfImpl: async (candidatePid, ancestorPid) => {
        ancestryChecks.push([candidatePid, ancestorPid]);
        return ancestryQueue.shift() ?? false;
      },
      getProcessGroupIdImpl: async () => {
        throw new Error('Windows ownership must not use process groups');
      },
      recordStackRuntimeUpdateImpl: async () => {},
      waitForServerReadyImpl: async () => {},
      readWatchChangeSignatureImpl: createChangingSignatureReader(),
      logger: {
        log() {},
        error(message) {
          errors.push(String(message));
        },
      },
    }
  );

  try {
    await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });
  } finally {
    watcher?.close?.();
  }

  return { serverProcRef, taskkillCalls, ancestryChecks, errors, spawnCalls };
}

test('watchDevServerAndRestart watches server-light because dev:light does not self-reload', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const watcher = watchDevServerAndRestart(createWatcherOptions(serverDir));

    try {
      assert.ok(watcher, 'expected a server-light watcher when stack watch mode is enabled');
      assert.equal(typeof watcher.close, 'function');
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart serializes pending server-light restarts', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    let firstReadyCompleted = false;
    let concurrentRestartStarted = false;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          if (spawnCalls > 1 && !firstReadyCompleted) {
            concurrentRestartStarted = true;
          }
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        listListenPidsImpl: async () => [spawnCalls === 0 ? 101 : 200 + spawnCalls],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
          if (readyCalls === 1) {
            await capturedOnChange({ eventType: 'change', filename: 'second-change.ts' });
            assert.equal(spawnCalls, 1, 'pending change must not spawn before the active restart is ready');
            firstReadyCompleted = true;
          }
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(concurrentRestartStarted, false);
      assert.equal(spawnCalls, 2);
      assert.equal(readyCalls, 2);
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(
        children.map((child) => child.pid),
        [201, 202]
      );
      assert.equal(serverProcRef.current.pid, 202);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart keeps the existing server when preflight rebuild fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    const killedPids = [];
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        preflightDevServerRestartImpl: async () => {
          throw new Error('server build failed');
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.deepEqual(killedPids, []);
      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 101);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart waits for the old server port to be released before spawning', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let waitForPortFreeCalls = 0;
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => {
          waitForPortFreeCalls += 1;
          return true;
        },
        pmSpawnScriptImpl: async () => {
          assert.equal(waitForPortFreeCalls, 1, 'must wait for the old listener to release before spawning');
          spawnCalls += 1;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => [202],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(waitForPortFreeCalls, 1);
      assert.equal(spawnCalls, 1);
      assert.equal(serverProcRef.current.pid, 201);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart rejects readiness from a listener outside the spawned process group', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let recordCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => [999],
        getProcessGroupIdImpl: async (pid) => (Number(pid) === 201 ? 201 : 999),
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(spawnCalls, 1);
      assert.equal(recordCalls, 0, 'must not record a PID when another process owns readiness');
      assert.equal(serverProcRef.current.pid, 101);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart fails closed when readiness ownership has no listener evidence', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let recordCalls = 0;
    const killedPids = [];
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [] : [101]),
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(recordCalls, 0, 'must not record a replacement PID without listener proof');
      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, [], 'failed provisional replacement must be removed from exit cleanup children');
      assert.deepEqual(killedPids, [101, 201]);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart fails closed when spawned process group cannot be discovered', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let recordCalls = 0;
    const killedPids = [];
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [202] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned && Number(pid) !== 101 ? null : 101),
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(recordCalls, 0, 'must not record a replacement PID without process-group proof');
      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, [], 'failed provisional replacement must be removed from exit cleanup children');
      assert.deepEqual(killedPids, [101, 201]);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart fails closed when port listeners are mixed across process groups', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let recordCalls = 0;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [201, 999] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? (Number(pid) === 201 ? 201 : 999) : 101),
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(recordCalls, 0, 'must not record a replacement PID when any listener is outside the spawned group');
      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, []);
      assert.deepEqual(killedPids, [101, 201]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart cleans up an unadopted replacement after ownership failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [999] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? (Number(pid) === 201 ? 201 : 999) : 101),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, [], 'replacement child must not remain registered after failed adoption');
      assert.deepEqual(killedPids, [101, 201]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart keeps failed replacement registered when direct termination is not confirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: Number(pid) === 101 };
        },
        terminateSpawnedChildImpl: async () => false,
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [999] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? (Number(pid) === 201 ? 201 : 999) : 101),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children.map((child) => child.pid), [201]);
      assert.deepEqual(killedPids, [101, 201]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart directly terminates an unadopted replacement when marker cleanup refuses', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const directlyKilled = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: Number(pid) === 101 };
        },
        terminateSpawnedChildImpl: async (child) => {
          directlyKilled.push({ pid: child?.pid });
          return true;
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [999] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? (Number(pid) === 201 ? 201 : 999) : 101),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, [], 'replacement child must be unregistered after direct cleanup');
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(directlyKilled, [{ pid: 201 }]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart keeps pid-only marker cleanup registered when direct termination is not confirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const directlyKilled = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return Number(pid) === 201
            ? { killed: true, reason: 'killed_pid_only' }
            : { killed: true, reason: 'killed_pgid' };
        },
        terminateSpawnedChildImpl: async (child) => {
          directlyKilled.push({ pid: child?.pid });
          return false;
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        listListenPidsImpl: async () => (spawned ? [999] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? (Number(pid) === 201 ? 201 : 999) : 101),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children.map((child) => child.pid), [201]);
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(directlyKilled, [{ pid: 201 }]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart signals an exited wrapper process group before unregistering failed replacement', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const signaled = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: Number(pid) === 101 };
        },
        signalSpawnedProcessGroupImpl: (child, signal) => {
          signaled.push({ pid: child?.pid, signal });
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: 0 };
        },
        listListenPidsImpl: async () => (spawned ? [201] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? 201 : Number(pid)),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, []);
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(signaled, [{ pid: 201, signal: 'SIGTERM' }]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart unregisters a signal-exited failed replacement', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const killedPids = [];
    const signaled = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: Number(pid) === 101 };
        },
        signalSpawnedProcessGroupImpl: (child, signal) => {
          signaled.push({ pid: child?.pid, signal });
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawned = true;
          return { pid: 201, exitCode: null, signalCode: 'SIGTERM' };
        },
        listListenPidsImpl: async () => (spawned ? [201] : [101]),
        getProcessGroupIdImpl: async (pid) => (spawned ? 201 : Number(pid)),
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current.pid, 101);
      assert.deepEqual(children, []);
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(signaled, [{ pid: 201, signal: 'SIGTERM' }]);
    } finally {
      watcher?.close?.();
    }
  });
});

test('startDevServer cleans up a spawned child when ownership proof fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const killedPids = [];
    const updates = [];

    await assert.rejects(
      () =>
        startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            serverPort: 34567,
            internalServerUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
            envPath: join(serverDir, 'env'),
            stackMode: true,
            runtimeStatePath: join(serverDir, 'stack.runtime.json'),
            serverAlreadyRunning: false,
            restart: false,
            children,
            quiet: true,
          },
          {
            platform: 'linux',
            ensureDepsInstalledImpl: async () => {},
            pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
            waitForServerReadyImpl: async () => {},
            listListenPidsImpl: async () => [],
            getProcessGroupIdImpl: async () => 201,
            killProcessGroupOwnedByStackImpl: async (pid) => {
              killedPids.push(pid);
              return { killed: true };
            },
            recordStackRuntimeUpdateImpl: async (_path, patch) => {
              updates.push(patch);
            },
          }
        ),
      /ownership could not be proven/
    );

    assert.deepEqual(children, []);
    assert.deepEqual(killedPids, [201]);
    assert.deepEqual(updates, []);
  });
});

test('watchDevServerAndRestart restarts Windows server after re-proving a listener descendant', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const result = await runWindowsWatcherChange(serverDir);

    assert.deepEqual(result.taskkillCalls, [[
      'taskkill.exe',
      ['/PID', '100', '/T', '/F'],
      { timeoutMs: 2000 },
    ]]);
    assert.deepEqual(result.ancestryChecks, [[300, 100], [300, 100]]);
    assert.equal(result.serverProcRef.current.pid, 201);
    assert.equal(result.spawnCalls, 1);
  });
});

test('watchDevServerAndRestart rejects an unproven Windows listener without terminating either PID', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const result = await runWindowsWatcherChange(serverDir, { ancestryResults: [false] });

    assert.deepEqual(result.taskkillCalls, []);
    assert.equal(result.serverProcRef.current.pid, 100);
    assert.equal(result.spawnCalls, 0);
    assert.ok(result.errors.some((message) => message.includes('server restart failed')));
  });
});

test('watchDevServerAndRestart refuses Windows taskkill when immediate ancestry re-proof fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const result = await runWindowsWatcherChange(serverDir, { ancestryResults: [true, false] });

    assert.deepEqual(result.taskkillCalls, []);
    assert.equal(result.serverProcRef.current.pid, 100);
    assert.equal(result.spawnCalls, 0);
  });
});

test('watchDevServerAndRestart refuses a Windows creation identity mismatch', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const result = await runWindowsWatcherChange(serverDir, {
      identityResults: [
        { pid: 100, creationDate: 'created-first' },
        { pid: 100, creationDate: 'created-different' },
      ],
    });

    assert.deepEqual(result.taskkillCalls, []);
    assert.equal(result.serverProcRef.current.pid, 100);
    assert.equal(result.spawnCalls, 0);
  });
});

test('watchDevServerAndRestart fails closed for invalid or exited Windows roots', async (t) => {
  for (const current of [{ pid: 1, exitCode: null }, { pid: 100, exitCode: 0 }, { pid: 100, closed: true }]) {
    await withTempServerDir(t, async (serverDir) => {
      const result = await runWindowsWatcherChange(serverDir, {
        current,
        identityResults: [{ pid: current.pid, creationDate: 'created' }, { pid: current.pid, creationDate: 'created' }],
      });

      assert.deepEqual(result.taskkillCalls, []);
      assert.equal(result.serverProcRef.current, current);
      assert.equal(result.spawnCalls, 0);
    });
  }
});

test('watchDevServerAndRestart fails closed when Windows taskkill fails or times out', async (t) => {
  for (const runCaptureImpl of [
    async () => {
      throw new Error('taskkill nonzero');
    },
    async () => {
      throw new Error('taskkill timeout');
    },
  ]) {
    await withTempServerDir(t, async (serverDir) => {
      const result = await runWindowsWatcherChange(serverDir, { runCaptureImpl });

      assert.equal(result.taskkillCalls.length, 1);
      assert.equal(result.serverProcRef.current.pid, 100);
      assert.equal(result.spawnCalls, 0);
    });
  }
});

test('watchDevServerAndRestart does not spawn when the Windows root does not exit after taskkill', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const result = await runWindowsWatcherChange(serverDir, {
      waitForChildExitImpl: async () => false,
    });

    assert.equal(result.taskkillCalls.length, 1);
    assert.equal(result.serverProcRef.current.pid, 100);
    assert.equal(result.spawnCalls, 0);
  });
});

test('startDevServer accepts a Windows descendant listener owned by the spawned root', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children,
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        pmSpawnScriptImpl: async () => ({ pid: 100, exitCode: null }),
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async () => [300],
        platform: 'win32',
        isWindowsPidDescendantOfImpl: async (candidatePid, ancestorPid) => {
          assert.deepEqual([candidatePid, ancestorPid], [300, 100]);
          return true;
        },
        getProcessGroupIdImpl: async () => {
          throw new Error('Windows ownership must not use process groups');
        },
        recordStackRuntimeUpdateImpl: async () => {},
      }
    );

    assert.equal(out.serverProc.pid, 100);
  });
});

test('startDevServer rejects a Windows listener without proven ancestry', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    await assert.rejects(
      () => startDevServer(
        {
          serverComponentName: 'happier-server-light',
          serverDir,
          autostart: { stackName: 'watch-test', baseDir: serverDir },
          baseEnv: {
            HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
            HAPPIER_STACK_PRISMA_PUSH: '0',
            HAPPIER_STACK_MANAGED_INFRA: '0',
            HAPPIER_STACK_PRISMA_MIGRATE: '0',
          },
          serverPort: 34567,
          internalServerUrl: 'http://127.0.0.1:34567',
          publicServerUrl: 'http://127.0.0.1:34567',
          envPath: join(serverDir, 'env'),
          stackMode: true,
          runtimeStatePath: join(serverDir, 'stack.runtime.json'),
          serverAlreadyRunning: false,
          restart: false,
          children,
          quiet: true,
        },
        {
          ensureDepsInstalledImpl: async () => {},
          pmSpawnScriptImpl: async () => ({ pid: 100, exitCode: null }),
          waitForServerReadyImpl: async () => {},
          listListenPidsImpl: async () => [300],
          platform: 'win32',
          isWindowsPidDescendantOfImpl: async () => false,
          getProcessGroupIdImpl: async () => {
            throw new Error('Windows ownership must not use process groups');
          },
          killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
          recordStackRuntimeUpdateImpl: async () => {},
        }
      ),
      /answered by another process/
    );

    assert.deepEqual(children, []);
  });
});

test('startDevServer directly terminates a spawned child when marker cleanup refuses', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const killedPids = [];
    const directlyKilled = [];

    await assert.rejects(
      () =>
        startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            serverPort: 34567,
            internalServerUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
            envPath: join(serverDir, 'env'),
            stackMode: true,
            runtimeStatePath: join(serverDir, 'stack.runtime.json'),
            serverAlreadyRunning: false,
            restart: false,
            children,
            quiet: true,
          },
          {
            platform: 'linux',
            ensureDepsInstalledImpl: async () => {},
            pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
            waitForServerReadyImpl: async () => {},
            listListenPidsImpl: async () => [],
            getProcessGroupIdImpl: async () => 201,
            killProcessGroupOwnedByStackImpl: async (pid) => {
              killedPids.push(pid);
              return { killed: false, reason: 'not_owned' };
            },
            terminateSpawnedChildImpl: async (child) => {
              directlyKilled.push({ pid: child?.pid });
              return true;
            },
            recordStackRuntimeUpdateImpl: async () => {},
          }
        ),
      /ownership could not be proven/
    );

    assert.deepEqual(children, []);
    assert.deepEqual(killedPids, [201]);
    assert.deepEqual(directlyKilled, [{ pid: 201 }]);
  });
});

test('startDevServer runs stack restart cleanup even when existing server health check failed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const order = [];
    const children = [];

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children,
        quiet: true,
      },
      {
        platform: 'linux',
        ensureDepsInstalledImpl: async () => {
          order.push('deps');
        },
        preflightDevServerRestartImpl: async () => {
          order.push('preflight');
        },
        stopStackOwnedServerForRestartImpl: async () => {
          order.push('stop');
        },
        pmSpawnScriptImpl: async () => {
          order.push('spawn');
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {
          order.push('ready');
        },
        listListenPidsImpl: async () => [201],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeUpdateImpl: async () => {
          order.push('record');
        },
      }
    );

    assert.equal(out.serverProc.pid, 201);
    assert.deepEqual(order, ['deps', 'preflight', 'stop', 'spawn', 'ready', 'record']);
  });
});

test('watchDevServerAndRestart refuses to spawn when existing server is not stack-owned and port is occupied', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    const killedPids = [];
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: false, reason: 'not_owned' };
        },
        isTcpPortFreeImpl: async () => false,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.deepEqual(killedPids, []);
      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 101);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart refuses to spawn over a live current PID without listener proof', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        isTcpPortFreeImpl: async () => true,
        waitForTcpPortFreeImpl: async () => true,
        isPidAliveImpl: () => true,
        listListenPidsImpl: async () => [],
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 101);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart can replace a dead adopted pid-only ref when the port is free', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };
    let spawned = false;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        isTcpPortFreeImpl: async () => true,
        waitForTcpPortFreeImpl: async () => true,
        isPidAliveImpl: () => false,
        listListenPidsImpl: async () => (spawned ? [201] : []),
        getProcessGroupIdImpl: async () => 201,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          spawned = true;
          return { pid: 201, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(spawnCalls, 1);
      assert.deepEqual(children.map((child) => child.pid), [201]);
      assert.equal(serverProcRef.current.pid, 201);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart does not kill current ref until it is proven to own the listener', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        isTcpPortFreeImpl: async () => false,
        listListenPidsImpl: async () => [222],
        getProcessGroupIdImpl: async (pid) => (Number(pid) === 101 ? 101 : 222),
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 201, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {},
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.deepEqual(killedPids, []);
      assert.equal(spawnCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 101);
    } finally {
      watcher?.close?.();
    }
  });
});

test('resolveStackOwnedServerListenPid returns a stack-owned listener for stale runtime repair', async () => {
  const pid = await resolveStackOwnedServerListenPid(
    { serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      listListenPidsImpl: async () => [222],
      isPidOwnedByStackImpl: async (candidate) => Number(candidate) === 222,
    }
  );

  assert.equal(pid, 222);
});

test('resolveStackOwnedServerListenPid refuses mixed stack-owned and unowned listeners', async () => {
  const pid = await resolveStackOwnedServerListenPid(
    { serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      listListenPidsImpl: async () => [222, 333],
      isPidOwnedByStackImpl: async (candidate) => Number(candidate) === 222,
      getProcessGroupIdImpl: async (candidate) => Number(candidate),
    }
  );

  assert.equal(pid, null);
});

test('stopStackOwnedServerForRestart repairs a stale runtime PID with a proven stack-owned listener', async () => {
  const server = await import('./server.mjs');
  assert.equal(typeof server.stopStackOwnedServerForRestart, 'function');

  const killedPids = [];
  const updates = [];

  await server.stopStackOwnedServerForRestart(
    {
      serverPort: 34567,
      runtimeStatePath: '/tmp/watch-test/stack.runtime.json',
      stackName: 'watch-test',
      envPath: '/tmp/watch-test/env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 101 } }),
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killedPids.push(pid);
        return { killed: pid === 222, reason: pid === 222 ? 'killed' : 'not_owned' };
      },
      isTcpPortFreeImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 222,
      recordStackRuntimeUpdateImpl: async (_path, patch) => {
        updates.push(patch);
      },
      waitForTcpPortFreeImpl: async () => true,
    }
  );

  assert.deepEqual(killedPids, [222]);
  assert.deepEqual(updates, [{ processes: { serverPid: 222 } }]);
});

test('stopStackOwnedServerForRestart does not kill a recorded PID until it is proven to own the listener', async () => {
  const server = await import('./server.mjs');
  assert.equal(typeof server.stopStackOwnedServerForRestart, 'function');

  const killedPids = [];
  const updates = [];

  await server.stopStackOwnedServerForRestart(
    {
      serverPort: 34567,
      runtimeStatePath: '/tmp/watch-test/stack.runtime.json',
      stackName: 'watch-test',
      envPath: '/tmp/watch-test/env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 101 } }),
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsImpl: async () => [222],
      getProcessGroupIdImpl: async (pid) => (Number(pid) === 101 ? 101 : 222),
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killedPids.push(pid);
        return { killed: true };
      },
      isTcpPortFreeImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 222,
      recordStackRuntimeUpdateImpl: async (_path, patch) => {
        updates.push(patch);
      },
      waitForTcpPortFreeImpl: async () => true,
    }
  );

  assert.deepEqual(killedPids, [222]);
  assert.deepEqual(updates, [{ processes: { serverPid: 222 } }]);
});

test('stopStackOwnedServerForRestart refuses a live recorded PID that no longer has listener proof', async () => {
  const server = await import('./server.mjs');
  assert.equal(typeof server.stopStackOwnedServerForRestart, 'function');

  const killedPids = [];
  let waitedForPortFree = false;

  await assert.rejects(
    () =>
      server.stopStackOwnedServerForRestart(
        {
          serverPort: 34567,
          runtimeStatePath: '/tmp/watch-test/stack.runtime.json',
          stackName: 'watch-test',
          envPath: '/tmp/watch-test/env',
        },
        {
          readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 101 } }),
          isPidAliveImpl: () => true,
          isPidOwnedByStackImpl: async () => true,
          listListenPidsImpl: async () => [],
          getProcessGroupIdImpl: async () => 101,
          killProcessGroupOwnedByStackImpl: async (pid) => {
            killedPids.push(pid);
            return { killed: true, reason: 'killed_pgid' };
          },
          isTcpPortFreeImpl: async () => true,
          waitForTcpPortFreeImpl: async () => {
            waitedForPortFree = true;
            return true;
          },
        }
      ),
    /recorded server pid 101 is still alive/
  );

  assert.deepEqual(killedPids, []);
  assert.equal(waitedForPortFree, false);
});

test('resolveStackOwnedServerRuntimePid rejects a live runtime PID without stack-owned listener proof', async () => {
  const server = await import('./server.mjs');
  assert.equal(typeof server.resolveStackOwnedServerRuntimePid, 'function');

  const pid = await server.resolveStackOwnedServerRuntimePid(
    {
      runtimeStatePath: '/tmp/watch-test/stack.runtime.json',
      serverPort: 34567,
      stackName: 'watch-test',
      envPath: '/tmp/watch-test/env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 101 } }),
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsImpl: async () => [],
      getProcessGroupIdImpl: async () => 101,
      resolveStackOwnedServerListenPidImpl: async () => null,
    }
  );

  assert.equal(pid, null);
});

test('resolveStackOwnedServerRuntimePid repairs an unrelated live runtime PID with a proven listener', async () => {
  const server = await import('./server.mjs');
  assert.equal(typeof server.resolveStackOwnedServerRuntimePid, 'function');

  const pid = await server.resolveStackOwnedServerRuntimePid(
    {
      runtimeStatePath: '/tmp/watch-test/stack.runtime.json',
      serverPort: 34567,
      stackName: 'watch-test',
      envPath: '/tmp/watch-test/env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 101 } }),
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 222,
    }
  );

  assert.equal(pid, 222);
});

test('watchDevServerAndRestart watches source/config paths instead of the whole server directory', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await mkdir(join(serverDir, 'sources'), { recursive: true });
    let capturedPaths = null;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir),
      {
        watchDebouncedImpl: ({ paths }) => {
          capturedPaths = paths;
          return { close() {} };
        },
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      assert.ok(Array.isArray(capturedPaths));
      assert.ok(!capturedPaths.includes(serverDir), 'must not watch the whole server directory');
      assert.ok(capturedPaths.every((p) => !p.includes('/dist') && !p.includes('/node_modules') && !p.includes('/logs')));
    } finally {
      watcher?.close?.();
    }
  });
});
