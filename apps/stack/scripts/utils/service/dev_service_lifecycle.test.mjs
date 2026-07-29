import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldExitAlreadyRunningDevStack } from './dev_service_lifecycle.mjs';

test('service-mode dev runner adopts an already-running stack instead of exiting', () => {
  const running = {
    restart: false,
    serverReady: true,
    daemonReady: true,
    expoReady: true,
  };

  assert.equal(shouldExitAlreadyRunningDevStack({ ...running, serviceMode: false }), true);
  assert.equal(shouldExitAlreadyRunningDevStack({ ...running, serviceMode: true }), false);
});
