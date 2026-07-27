import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSelfUpdateHarness } from './testkit/self_update_testkit.mjs';

test('hstack self update emits a structured terminal upgrade artifact', (t) => {
  const harness = createSelfUpdateHarness(t, { prefix: 'hstack-self-update-artifact-' });
  const result = harness.runSelfCommand(['update', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(typeof output.artifactPath, 'string');
  const artifact = JSON.parse(readFileSync(output.artifactPath, 'utf8'));
  assert.equal(artifact.status, 'succeeded');
  assert.equal(artifact.terminal, true);
  assert.equal(artifact.exitCode, 0);
  assert.equal(artifact.failureStage, null);
  assert.equal(Array.isArray(artifact.attempts), true);
  assert.equal(typeof artifact.packageVersions, 'object');
  assert.match(artifact.lockSha256, /^sha256:|^unavailable$/);
  assert.equal(typeof artifact.serviceHealth, 'object');
  assert.equal(artifact.serviceHealth.state, 'not_checked');
  assert.equal(artifact.serviceHealth.checkedAt, null);
  assert.equal(artifact.serviceHealth.runningServices, 'not_restarted');
  assert.equal(artifact.serviceHealth.reason, 'runtime_updated_services_not_restarted');
});

test('hstack self update records a terminal failure artifact when installation fails', (t) => {
  const harness = createSelfUpdateHarness(t, {
    prefix: 'hstack-self-update-artifact-failure-',
    installExitCode: 42,
    installStderr: 'fake install failure\n',
  });
  const result = harness.runSelfCommand(['update', '--json'], {
    extraEnv: { HAPPIER_STACK_UPDATE_PACKAGE_NAME: '@happier-dev/stack' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /upgrade artifact: /i);
  const artifactPath = result.stderr.match(/upgrade artifact: ([^)]+)\)/i)?.[1];
  assert.ok(artifactPath);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.terminal, true);
  assert.equal(artifact.exitCode, 42);
  assert.equal(artifact.failureStage, 'npm_install');
  assert.equal(artifact.serviceHealth.state, 'not_checked');
  assert.equal(artifact.serviceHealth.checkedAt, null);
  assert.equal(artifact.serviceHealth.runningServices, 'not_restarted');
  assert.equal(artifact.serviceHealth.reason, 'upgrade_failed_services_not_probed');
});
