import assert from 'node:assert/strict';
import test from 'node:test';

import { installWindowsRunKeyFallbackService } from './service.mjs';

test('Windows RunKey fallback installs the registration and starts the service immediately', async () => {
  const calls = [];

  const result = await installWindowsRunKeyFallbackService('dev.happier.stack.example', {
    install: async (label) => {
      calls.push(['install', label]);
      return { definitionPath: 'C:\\Users\\example\\.happier\\services\\example.ps1' };
    },
    start: (label) => {
      calls.push(['start', label]);
    },
  });

  assert.deepEqual(calls, [
    ['install', 'dev.happier.stack.example'],
    ['start', 'dev.happier.stack.example'],
  ]);
  assert.deepEqual(result, {
    backend: 'windows-run-key-user',
    fallback: true,
    definitionPath: 'C:\\Users\\example\\.happier\\services\\example.ps1',
  });
});
