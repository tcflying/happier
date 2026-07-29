import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  acquireWindowsStackSupervisorLease,
  runWindowsStackSupervisor,
  waitForWindowsStackStartup,
} from './windows_stack_supervisor.mjs';

test('Windows stack supervisor lease rejects a second live owner', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-lock-' });
  const lockPath = join(fixture.root, 'supervisor.lock.json');

  const first = await acquireWindowsStackSupervisorLease({
    lockPath,
    pid: 111,
    generationId: 'generation-a',
    now: () => 1_000,
    isPidAliveImpl: (pid) => pid === 111,
  });
  assert.equal(first.ok, true);

  const second = await acquireWindowsStackSupervisorLease({
    lockPath,
    pid: 222,
    generationId: 'generation-b',
    now: () => 2_000,
    isPidAliveImpl: (pid) => pid === 111,
  });
  assert.deepEqual(second, {
    ok: false,
    reason: 'already_running',
    owner: {
      pid: 111,
      generationId: 'generation-a',
      acquiredAt: '1970-01-01T00:00:01.000Z',
    },
  });

  if (first.ok) {
    await first.release();
  }
});

test('Windows stack supervisor waits for relay, UI, then daemon readiness in order', async () => {
  const snapshots = [
    {
      status: 'starting',
      dimensions: {
        relay: { ok: false },
        ui: { ok: false },
        rpc: { ok: false },
        daemonAuth: { ok: false },
        machineRegistration: { ok: false },
        sessionRunner: { ok: false },
      },
    },
    {
      status: 'starting',
      dimensions: {
        relay: { ok: true },
        ui: { ok: false },
        rpc: { ok: false },
        daemonAuth: { ok: false },
        machineRegistration: { ok: false },
        sessionRunner: { ok: false },
      },
    },
    {
      status: 'starting',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: false },
        daemonAuth: { ok: false },
        machineRegistration: { ok: false },
        sessionRunner: { ok: false },
      },
    },
    {
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    },
  ];
  const phases = [];
  let probeIndex = 0;

  const result = await waitForWindowsStackStartup({
    probeHealth: async () => snapshots[Math.min(probeIndex++, snapshots.length - 1)],
    sleep: async () => {},
    maxAttempts: 4,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(phases, ['relay', 'ui', 'daemon', 'ready']);
  assert.equal(probeIndex, 4);
});

test('Windows stack supervisor restarts the canonical stack once after a child crash', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-restart-' });
  const events = [{ type: 'exit', code: 1, signal: null }, { type: 'stop_requested' }];
  const started = [];
  const stopped = [];
  const states = [];

  const result = await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 333,
    generationId: 'generation-restart',
    now: () => 10_000,
    isPidAliveImpl: (pid) => pid === 333,
    startStack: async () => {
      const child = { pid: 400 + started.length, exitCode: null };
      started.push(child.pid);
      return child;
    },
    stopStack: async (child) => {
      stopped.push(child.pid);
    },
    probeHealth: async () => ({
      status: 'healthy',
      restartable: true,
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => events.shift(),
    sleep: async () => {},
    writeState: async (state) => states.push(state),
    maxRestarts: 3,
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(started, [400, 401]);
  assert.deepEqual(stopped, [400, 401]);
  assert.equal(states.filter((state) => state.phase === 'restarting').length, 1);
});

test('Windows stack supervisor stops after the crash budget is exhausted', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-budget-' });
  let starts = 0;

  const result = await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 444,
    generationId: 'generation-budget',
    now: () => 20_000,
    isPidAliveImpl: (pid) => pid === 444,
    startStack: async () => ({ pid: 500 + starts++, exitCode: null }),
    stopStack: async () => {},
    probeHealth: async () => ({
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => ({ type: 'exit', code: 1, signal: null }),
    sleep: async () => {},
    writeState: async () => {},
    maxRestarts: 1,
    initialRestartTimestamps: [19_500],
  });

  assert.equal(result.status, 'crash_budget_exhausted');
  assert.equal(result.state.phase, 'crash_budget_exhausted');
  assert.equal(result.state.restartCount, 1);
  assert.equal(starts, 1);
});

test('Windows stack supervisor performs an attributed safe stop before releasing ownership', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-stop-' });
  const events = [];
  const stopContexts = [];

  const result = await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 555,
    generationId: 'generation-stop',
    now: () => 30_000,
    isPidAliveImpl: (pid) => pid === 555,
    startStack: async () => ({ pid: 601, exitCode: null }),
    stopStack: async (_child, context) => {
      events.push('stop-stack');
      stopContexts.push(context);
    },
    probeHealth: async () => ({
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => ({ type: 'stop_requested' }),
    sleep: async () => {},
    writeState: async (state) => events.push(`state:${state.phase}`),
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(stopContexts, [{
    reason: 'stop_requested',
    requestedBy: 'windows_service_supervisor',
    preserveDaemon: false,
    stopSessions: true,
  }]);
  assert.ok(events.indexOf('state:stopping') < events.indexOf('stop-stack'));
  assert.ok(events.indexOf('stop-stack') < events.indexOf('state:stopped'));
});

test('Windows stack supervisor keeps a healthy child instead of restarting on monitor ticks', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-healthy-tick-' });
  const monitorEvents = [
    { type: 'health_ok' },
    { type: 'stop_requested' },
  ];
  let starts = 0;
  let stops = 0;

  const result = await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 556,
    generationId: 'generation-healthy-tick',
    now: () => 31_000,
    isPidAliveImpl: (pid) => pid === 556,
    startStack: async () => ({ pid: 610 + starts++, exitCode: null }),
    stopStack: async () => {
      stops += 1;
    },
    probeHealth: async () => ({
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => monitorEvents.shift(),
    sleep: async () => {},
    writeState: async () => {},
  });

  assert.equal(result.status, 'stopped');
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test('Windows stack supervisor keeps relay and UI available while daemon auth awaits user setup', async () => {
  const blocked = {
    status: 'blocked',
    restartable: false,
    dimensions: {
      relay: { ok: true },
      ui: { ok: true },
      rpc: { ok: false },
      daemonAuth: { ok: false, status: 'auth_required' },
      machineRegistration: { ok: false, status: 'registration_required' },
      sessionRunner: { ok: false },
    },
  };
  const phases = [];

  const result = await waitForWindowsStackStartup({
    probeHealth: async () => blocked,
    sleep: async () => {},
    maxAttempts: 1,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(phases, ['ready']);
  assert.equal(result.report.status, 'blocked');
});

test('Windows stack supervisor preserves detached session runners during an infra restart request', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-restart-stop-policy-' });
  let stopContext = null;

  await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 557,
    generationId: 'generation-restart-stop-policy',
    now: () => 32_000,
    isPidAliveImpl: (pid) => pid === 557,
    startStack: async () => ({ pid: 620, exitCode: null }),
    stopStack: async (_child, context) => {
      stopContext = context;
    },
    probeHealth: async () => ({
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => ({
      type: 'stop_requested',
      stopSessions: false,
      preserveDaemon: false,
    }),
    sleep: async () => {},
    writeState: async () => {},
  });

  assert.deepEqual(stopContext, {
    reason: 'stop_requested',
    requestedBy: 'windows_service_supervisor',
    preserveDaemon: false,
    stopSessions: false,
  });
});

test('Windows stack supervisor never reports stopped when safe stop fails', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-windows-supervisor-stop-failure-' });
  const states = [];

  const result = await runWindowsStackSupervisor({
    lockPath: join(fixture.root, 'supervisor.lock.json'),
    pid: 558,
    generationId: 'generation-stop-failure',
    now: () => 33_000,
    isPidAliveImpl: (pid) => pid === 558,
    startStack: async () => ({ pid: 630, exitCode: null }),
    stopStack: async () => {
      throw new Error('canonical stop failed');
    },
    probeHealth: async () => ({
      status: 'healthy',
      dimensions: {
        relay: { ok: true },
        ui: { ok: true },
        rpc: { ok: true },
        daemonAuth: { ok: true },
        machineRegistration: { ok: true },
        sessionRunner: { ok: true },
      },
    }),
    waitForEvent: async () => ({ type: 'stop_requested' }),
    sleep: async () => {},
    writeState: async (state) => states.push(state),
  });

  assert.equal(result.status, 'stop_failed');
  assert.equal(result.state.phase, 'stop_failed');
  assert.equal(states.some((state) => state.phase === 'stopped'), false);
});
