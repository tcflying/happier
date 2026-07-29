import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  resolveWindowsStackSupervisorPaths,
  requestWindowsStackSupervisorStop,
  runWindowsStackSupervisorRuntime,
  waitForWindowsStackMonitorEvent,
  waitForWindowsStackSupervisorStop,
} from './windows_stack_supervisor_runtime.mjs';

test('Windows supervisor runtime launches the canonical stack and uses canonical safe stop', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-runtime-' });
  const baseDir = join(fixture.root, 'main');
  const spawned = [];
  const stopped = [];

  const result = await runWindowsStackSupervisorRuntime({
    rootDir: fixture.root,
    baseDir,
    stackName: 'main',
    env: { HAPPIER_STACK_ENV_FILE: join(baseDir, 'env') },
    pid: 777,
    generationId: 'runtime-generation',
    now: () => 40_000,
    isPidAliveImpl: (pid) => pid === 777 || pid === 801,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 801, exitCode: null };
    },
    collectHealthImpl: async () => ({
      status: 'healthy',
      restartable: false,
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEventImpl: async () => ({ type: 'stop_requested' }),
    stopStackWithEnvImpl: async (options) => {
      stopped.push(options);
      return { ok: true };
    },
    sleepImpl: async () => {},
  });

  assert.equal(result.status, 'stopped');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.deepEqual(spawned[0].args, [
    join(fixture.root, 'scripts', 'run.mjs'),
    '--restart',
    '--no-browser',
  ]);
  assert.equal(spawned[0].options.env.HAPPIER_STACK_SERVICE_MODE, '1');
  assert.equal(spawned[0].options.env.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH, '1');
  assert.deepEqual(stopped.map((entry) => ({
    stackName: entry.stackName,
    baseDir: entry.baseDir,
    aggressive: entry.aggressive,
    preserveDaemon: entry.preserveDaemon,
  })), [{
    stackName: 'main',
    baseDir,
    aggressive: true,
    preserveDaemon: false,
  }]);

  const paths = resolveWindowsStackSupervisorPaths({ baseDir });
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(state.phase, 'stopped');
  assert.equal(state.generationId, 'runtime-generation');
});

test('Windows supervisor runtime can launch and health-check the stack development UI', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-runtime-dev-' });
  const baseDir = join(fixture.root, 'dev');
  const supervisorPaths = resolveWindowsStackSupervisorPaths({ baseDir });
  await mkdir(baseDir, { recursive: true });
  await writeFile(supervisorPaths.statePath, JSON.stringify({
    phase: 'starting',
    restartTimestamps: [40_100, 40_200, 40_300],
  }));
  const spawned = [];
  const healthInputs = [];

  const result = await runWindowsStackSupervisorRuntime({
    rootDir: fixture.root,
    baseDir,
    stackName: 'dev',
    env: {
      HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'),
      HAPPIER_STACK_SERVICE_RUN_MODE: 'dev',
      HAPPIER_STACK_EXPO_DEV_PORT: '18287',
      HAPPIER_STACK_SERVER_PORT: '52211',
    },
    pid: 778,
    generationId: 'runtime-dev-generation',
    now: () => 400_000,
    isPidAliveImpl: (pid) => pid === 778 || pid === 802,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 802, exitCode: null };
    },
    collectHealthImpl: async (options) => {
      healthInputs.push(options);
      const ready = healthInputs.length > 100;
      return {
        status: ready ? 'healthy' : 'unhealthy',
        restartable: !ready,
        dimensions: {
          relay: { ok: true },
          ui: { ok: ready },
          rpc: { ok: true },
          daemonAuth: { ok: true },
          machineRegistration: { ok: true },
          sessionRunner: { ok: true },
        },
      };
    },
    waitForEventImpl: async () => ({ type: 'stop_requested', preserveDaemon: true }),
    stopStackWithEnvImpl: async () => ({ ok: true }),
    sleepImpl: async () => {},
  });

  assert.equal(result.status, 'stopped');
  assert.equal(spawned.length, 1, 'dev UI warm-up should not consume a restart');
  assert.deepEqual(spawned[0].args, [
    join(fixture.root, 'scripts', 'dev.mjs'),
    '--no-browser',
  ]);
  assert.equal(healthInputs[0].relayUrl, 'http://127.0.0.1:52211');
  assert.equal(healthInputs[0].uiUrl, 'http://127.0.0.1:18287');
  const state = JSON.parse(await readFile(supervisorPaths.statePath, 'utf8'));
  assert.equal(state.restartCount, 0, 'a new supervisor should prune an expired crash budget');
});

test('Windows service stop targets the active generation and waits for supervisor exit', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-stop-request-' });
  const baseDir = join(fixture.root, 'main');
  const paths = resolveWindowsStackSupervisorPaths({ baseDir });
  await mkdir(baseDir, { recursive: true });
  await writeFile(paths.statePath, JSON.stringify({
    phase: 'running',
    supervisorPid: 911,
    generationId: 'generation-active',
  }));

  const request = await requestWindowsStackSupervisorStop({
    baseDir,
    requestedBy: 'test',
    reason: 'safe stop proof',
    stopSessions: false,
    preserveDaemon: false,
    now: () => 50_000,
  });
  assert.equal(request.targetGenerationId, 'generation-active');
  assert.equal(request.stopSessions, false);

  let probes = 0;
  const waited = await waitForWindowsStackSupervisorStop({
    baseDir,
    timeoutMs: 5_000,
    now: () => 50_000 + probes * 250,
    sleep: async () => {
      probes += 1;
    },
    isPidAliveImpl: () => probes === 0,
  });

  assert.equal(waited.stopped, true);
  assert.equal(waited.supervisorPid, 911);
});

test('Windows supervisor monitor observes a stop request before the health interval elapses', async () => {
  let healthProbes = 0;
  const event = await waitForWindowsStackMonitorEvent({
    child: { pid: 912, exitCode: null },
    generationId: 'generation-monitor',
    healthIntervalMs: 15_000,
    stopPollMs: 250,
    now: () => 60_000,
    waitForChildEvent: async () => ({ type: 'timeout' }),
    shouldStopSignal: () => false,
    readStopRequest: async () => ({
      targetGenerationId: 'generation-monitor',
      requestedBy: 'service restart',
      stopSessions: false,
      preserveDaemon: false,
    }),
    probeHealth: async () => {
      healthProbes += 1;
      throw new Error('health should not run before the stop request is observed');
    },
  });

  assert.deepEqual(event, {
    type: 'stop_requested',
    source: 'request_file',
    requestedBy: 'service restart',
    stopSessions: false,
    preserveDaemon: false,
  });
  assert.equal(healthProbes, 0);
});
