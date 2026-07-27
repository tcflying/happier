import assert from 'node:assert/strict';
import test from 'node:test';

import { renderWindowsStackSupervisorStatusText } from './windows_stack_supervisor_status.mjs';

test('Windows service status renders every supervised health dimension', () => {
  const text = renderWindowsStackSupervisorStatusText({
    running: true,
    state: {
      phase: 'running',
      supervisorPid: 901,
      childPid: 902,
      restartCount: 1,
      updatedAt: '2026-07-27T12:00:00.000Z',
      health: {
        status: 'blocked',
        restartable: false,
        dimensions: {
          relay: { ok: true, status: 'ready' },
          ui: { ok: true, status: 'ready' },
          rpc: { ok: false, status: 'daemon_not_running' },
          daemonAuth: { ok: false, status: 'auth_required' },
          machineRegistration: { ok: false, status: 'registration_required' },
          sessionRunner: { ok: false, status: 'rpc_unavailable', tracked: 0, live: 0 },
        },
      },
    },
  });

  assert.match(text, /supervisor:\s+running/);
  assert.match(text, /relay:\s+ready/);
  assert.match(text, /UI:\s+ready/);
  assert.match(text, /RPC:\s+daemon_not_running/);
  assert.match(text, /daemon auth:\s+auth_required/);
  assert.match(text, /machine registration:\s+registration_required/);
  assert.match(text, /session runner:\s+rpc_unavailable/);
});
