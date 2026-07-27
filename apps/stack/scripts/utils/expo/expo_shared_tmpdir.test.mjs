import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureExpoIsolationEnv, resolveExpoTmpDir } from './expo.mjs';

function sha1_12(s) {
  return createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
}

test('resolveExpoTmpDir returns default when shared tmpdir is not configured', () => {
  const def = '/tmp/default';
  const got = resolveExpoTmpDir({
    env: {},
    defaultTmpDir: def,
    kind: 'expo-dev',
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, def);
});

test('resolveExpoTmpDir uses shared base dir + key when configured', () => {
  const base = '/cache/expo';
  const key = 'happier-dev/happier';
  const kind = 'expo-dev';
  const expected = join(base, 'tmp', kind, sha1_12(key));
  const got = resolveExpoTmpDir({
    env: {
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR: base,
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY: key,
    },
    defaultTmpDir: '/tmp/default',
    kind,
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, expected);
});

test('ensureExpoIsolationEnv isolates every Node temporary-directory variable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-expo-isolation-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    TMPDIR: 'inherited-tmpdir',
    TMP: 'inherited-tmp',
    TEMP: 'inherited-temp',
  };

  await ensureExpoIsolationEnv({
    env,
    stateDir: join(root, 'state'),
    expoHomeDir: join(root, 'expo-home'),
    tmpDir: join(root, 'tmp'),
  });

  assert.equal(env.TMPDIR, join(root, 'tmp'));
  assert.equal(env.TMP, join(root, 'tmp'));
  assert.equal(env.TEMP, join(root, 'tmp'));
});
