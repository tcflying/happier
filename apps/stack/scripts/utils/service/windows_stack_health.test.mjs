import assert from 'node:assert/strict';
import test from 'node:test';

import { collectWindowsStackHealth } from './windows_stack_health.mjs';

test('Windows stack health reports relay, UI, RPC, daemon auth, registration, and runners separately', async () => {
  const result = await collectWindowsStackHealth({
    relayUrl: 'http://127.0.0.1:52211',
    uiUrl: 'http://127.0.0.1:18287',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<!doctype html><title>Happier</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    readDaemonStatus: async () => ({
      daemon: { running: true, pid: 701, httpPort: 17001 },
      auth: {
        authenticated: true,
        needsAuth: false,
        machineRegistered: true,
        machineId: 'machine-1',
      },
    }),
    readDaemonControlState: async () => ({
      pid: 701,
      httpPort: 17001,
      controlToken: 'must-not-leak',
    }),
    postDaemonControl: async ({ path }) => (
      path === '/ping'
        ? { status: 'ok' }
        : { children: [{ startedBy: 'daemon', happySessionId: 'session-1', pid: 702 }] }
    ),
    isPidAliveImpl: (pid) => pid === 701 || pid === 702,
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.restartable, false);
  assert.deepEqual(Object.keys(result.dimensions), [
    'relay',
    'ui',
    'rpc',
    'daemonAuth',
    'machineRegistration',
    'sessionRunner',
  ]);
  assert.deepEqual(result.dimensions, {
    relay: { ok: true, status: 'ready', url: 'http://127.0.0.1:52211/health' },
    ui: { ok: true, status: 'ready', url: 'http://127.0.0.1:18287/' },
    rpc: { ok: true, status: 'ready', daemonPid: 701, httpPort: 17001 },
    daemonAuth: { ok: true, status: 'authenticated' },
    machineRegistration: { ok: true, status: 'registered', machineId: 'machine-1' },
    sessionRunner: {
      ok: true,
      status: 'ready',
      tracked: 1,
      live: 1,
      staleSessionIds: [],
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});
