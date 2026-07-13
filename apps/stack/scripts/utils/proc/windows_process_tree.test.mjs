import assert from 'node:assert/strict';
import test from 'node:test';

import { isWindowsPidDescendantOf, readWindowsProcessIdentity, readWindowsProcessParents } from './windows_process_tree.mjs';

test('isWindowsPidDescendantOf accepts a transitive child', async () => {
  const result = await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => new Map([[300, 200], [200, 100], [100, 50]]),
  });
  assert.equal(result, true);
});

test('isWindowsPidDescendantOf rejects unrelated and cyclic ancestry', async () => {
  assert.equal(await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => new Map([[300, 200], [200, 300]]),
  }), false);
});

test('isWindowsPidDescendantOf fails closed when a parent is missing', async () => {
  assert.equal(await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => new Map([[300, 200]]),
  }), false);
});

test('isWindowsPidDescendantOf fails closed when the process snapshot fails', async () => {
  assert.equal(await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => {
      throw new Error('CIM unavailable');
    },
  }), false);
});

test('readWindowsProcessParents uses the constant PowerShell snapshot script', async () => {
  const calls = [];
  const result = await readWindowsProcessParents({
    timeoutMs: 1234,
    runCaptureImpl: async (...args) => {
      calls.push(args);
      return '[{"ProcessId":300,"ParentProcessId":200},{"ProcessId":200,"ParentProcessId":100}]';
    },
  });

  assert.deepEqual(result, new Map([[300, 200], [200, 100]]));
  assert.deepEqual(calls, [[
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { timeoutMs: 1234 },
  ]]);
});

test('readWindowsProcessParents parses a single process snapshot object', async () => {
  const result = await readWindowsProcessParents({
    runCaptureImpl: async () => '{"ProcessId":300,"ParentProcessId":200}',
  });

  assert.deepEqual(result, new Map([[300, 200]]));
});

test('isWindowsPidDescendantOf fails closed for null, empty, and malformed snapshots', async () => {
  for (const raw of ['null', '', '{']) {
    assert.equal(await isWindowsPidDescendantOf(300, 100, {
      readParentsImpl: () => readWindowsProcessParents({ runCaptureImpl: async () => raw }),
    }), false, `snapshot ${JSON.stringify(raw)} must fail closed`);
  }
});

test('readWindowsProcessIdentity captures a stable creation marker with a constant script', async () => {
  const calls = [];
  const result = await readWindowsProcessIdentity(100, {
    timeoutMs: 1234,
    runCaptureImpl: async (...args) => {
      calls.push(args);
      return '{"ProcessId":100,"CreationDate":"20260713143000.000000+480"}';
    },
  });

  assert.deepEqual(result, { pid: 100, creationDate: '20260713143000.000000+480' });
  assert.deepEqual(calls, [[
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress'],
    { timeoutMs: 1234 },
  ]]);
});

test('readWindowsProcessIdentity fails closed for invalid PID or malformed identity output', async () => {
  let calls = 0;
  assert.equal(await readWindowsProcessIdentity(1, {
    runCaptureImpl: async () => {
      calls += 1;
      return '{}';
    },
  }), null);
  assert.equal(calls, 0);
  assert.equal(await readWindowsProcessIdentity(100, {
    runCaptureImpl: async () => '{',
  }), null);
});
