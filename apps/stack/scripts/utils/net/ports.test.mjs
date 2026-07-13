import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { isTcpPortFree } from './ports.mjs';

async function getUnusedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolvePromise, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to allocate a free TCP port');
  await new Promise((resolvePromise) => srv.close(resolvePromise));
  return port;
}

test(
  'isTcpPortFree resolves (fails closed) when the bind-probe cannot close cleanly',
  { timeout: 2000 },
  async (t) => {
    const port = await getUnusedLoopbackPort();

    t.mock.method(net, 'createServer', () => {
      return {
        unref() {},
        on() {
          return this;
        },
        listen(_opts, cb) {
          queueMicrotask(cb);
          return this;
        },
        close() {
          // Simulate a broken/never-closing server.close callback.
        },
      };
    });

    const out = await isTcpPortFree(port, { host: '127.0.0.1', timeoutMs: 25 });
    assert.equal(out, false);
  }
);

test('listListenPidsWithStatus reports unsupported listener discovery when lsof is unavailable', async () => {
  const ports = await import('./ports.mjs');
  assert.equal(typeof ports.listListenPidsWithStatus, 'function');

  const out = await ports.listListenPidsWithStatus(34567, {
    resolveCommandPathImpl: async () => '',
    runCaptureImpl: async () => {
      throw new Error('must not run listener discovery without a resolved command');
    },
    platform: 'linux',
  });

  assert.equal(out.supported, false);
  assert.deepEqual(out.pids, []);
});

test('parseWindowsNetstatListenPids returns exact IPv4 and IPv6 listener PIDs', async () => {
  const { parseWindowsNetstatListenPids } = await import('./ports.mjs');
  const raw = [
    '  TCP    0.0.0.0:52211          0.0.0.0:0              LISTENING       66988',
    '  TCP    [::]:52211             [::]:0                 LISTENING       66988',
    '  TCP    127.0.0.1:522110       0.0.0.0:0              LISTENING       77777',
    '  TCP    127.0.0.1:52211        127.0.0.1:60000        ESTABLISHED     88888',
  ].join('\r\n');
  assert.deepEqual(parseWindowsNetstatListenPids(raw, 52211), [66988]);
});

test('listListenPidsWithStatus uses netstat on Windows', async () => {
  const { listListenPidsWithStatus } = await import('./ports.mjs');
  const calls = [];
  const result = await listListenPidsWithStatus(52211, {
    platform: 'win32',
    resolveCommandPathImpl: async (name) => name === 'netstat' ? 'C:\\Windows\\System32\\netstat.exe' : '',
    runCaptureImpl: async (command, args) => {
      calls.push({ command, args });
      return 'TCP 0.0.0.0:52211 0.0.0.0:0 LISTENING 66988';
    },
  });
  assert.deepEqual(result, { supported: true, pids: [66988] });
  assert.deepEqual(calls, [{ command: 'C:\\Windows\\System32\\netstat.exe', args: ['-ano', '-p', 'tcp'] }]);
});
