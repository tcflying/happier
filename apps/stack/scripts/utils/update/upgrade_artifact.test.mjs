import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createUpgradeArtifactWriter } from './upgrade_artifact.mjs';

test('an interrupted upgrade remains explicitly in progress instead of looking complete', async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-upgrade-artifact-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(homeDir, { recursive: true, force: true });
  });

  const writer = createUpgradeArtifactWriter({
    homeDir,
    operationId: 'operation-1',
    now: () => '2026-07-27T04:45:00.000Z',
  });
  await writer.start({
    packageName: '@happier-dev/stack',
    requestedSpec: '@happier-dev/stack@latest',
  });

  const files = await readdir(join(homeDir, 'artifacts', 'upgrades'));
  assert.deepEqual(files, ['operation-1.in-progress.json']);
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
  const artifact = JSON.parse(await readFile(writer.inProgressPath, 'utf8'));
  assert.equal(artifact.status, 'running');
  assert.equal(artifact.terminal, false);
  assert.equal(artifact.finishedAt, null);
});

test('finishing an upgrade atomically replaces the in-progress marker with a terminal artifact', async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-upgrade-artifact-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(homeDir, { recursive: true, force: true });
  });

  const times = ['2026-07-27T04:45:00.000Z', '2026-07-27T04:45:05.000Z'];
  const writer = createUpgradeArtifactWriter({
    homeDir,
    operationId: 'operation-2',
    now: () => times.shift() ?? '2026-07-27T04:45:05.000Z',
  });
  await writer.start({
    packageName: '@happier-dev/stack',
    requestedSpec: '@happier-dev/stack@latest',
  });
  await writer.finish({
    status: 'succeeded',
    exitCode: 0,
    failureStage: null,
    attempts: [{ stage: 'npm_install', exitCode: 0 }],
    packageVersions: { before: '1.0.0', after: '1.1.0' },
    lockSha256: 'sha256:abc',
    serviceHealth: { state: 'not_checked', checkedAt: null },
  });

  const files = await readdir(join(homeDir, 'artifacts', 'upgrades'));
  assert.deepEqual(files, ['operation-2.json']);
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
  const artifact = JSON.parse(await readFile(writer.finalPath, 'utf8'));
  assert.equal(artifact.status, 'succeeded');
  assert.equal(artifact.terminal, true);
  assert.equal(artifact.exitCode, 0);
  assert.equal(artifact.retryCount, 0);
  assert.equal(artifact.finishedAt, '2026-07-27T04:45:05.000Z');
});
