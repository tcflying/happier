import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { ensureDevExpoServer } from './expo_dev.mjs';

async function createFixture() {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-legacy-pid-state-'));
  const uiDir = join(tmp, 'ui');
  await mkdir(join(uiDir, 'node_modules'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf8');
  const paths = getExpoStatePaths({
    baseDir: tmp,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  await writePidState(paths.statePath, {
    pid: process.pid,
    port: 8081,
    uiDir,
    projectDir: uiDir,
    webEnabled: true,
    devClientEnabled: false,
  });
  return { tmp, uiDir, paths };
}

function createFakeExpoProcess(pid = 4242) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.completion = new Promise(() => {});
  return proc;
}

function buildBaseOptions({ tmp, uiDir, children, restart }) {
  return {
    startUi: true,
    startMobile: false,
    uiDir,
    autostart: { baseDir: tmp },
    baseEnv: buildStackFixtureEnv({
      baseEnv: process.env,
      stripStackEnv: true,
      extraEnv: { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' },
    }),
    apiServerUrl: 'http://127.0.0.1:1',
    restart,
    stackMode: false,
    runtimeStatePath: null,
    stackName: 'legacy-state-test',
    envPath: '',
    children,
    quiet: true,
    stateProcessPlatform: 'win32',
    readStateProcessIdentityLine: async () => ({
      commandLine: 'node.exe expo start --port 8081',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
      processInstanceFingerprint: 'win32-cim:live-legacy-process',
    }),
  };
}

test('legacy Windows state with a live PID blocks automatic replacement', async (t) => {
  const fixture = await createFixture();
  t.after(async () => rm(fixture.tmp, { recursive: true, force: true }));
  let spawnCalls = 0;
  let killCalls = 0;

  await assert.rejects(() => ensureDevExpoServer({
    ...buildBaseOptions({ ...fixture, children: [], restart: false }),
    spawnExpoProcess: async () => {
      spawnCalls += 1;
      return createFakeExpoProcess();
    },
    killOwnedProcessGroup: async () => {
      killCalls += 1;
      return { killed: true };
    },
  }), (error) => error?.code === 'EEXPOLEGACYPIDSTATE' && /--restart/.test(error.message));

  assert.equal(spawnCalls, 0);
  assert.equal(killCalls, 0);
});

test('explicit restart replaces a live legacy Windows PID only after ownership-gated cleanup', async (t) => {
  const fixture = await createFixture();
  t.after(async () => rm(fixture.tmp, { recursive: true, force: true }));
  const children = [];
  const replacement = createFakeExpoProcess();
  let spawnCalls = 0;
  let killCalls = 0;

  const result = await ensureDevExpoServer({
    ...buildBaseOptions({ ...fixture, children, restart: true }),
    killOwnedProcessGroup: async (pid) => {
      assert.equal(pid, process.pid);
      killCalls += 1;
      return { killed: true, reason: 'canonical_test_ownership' };
    },
    spawnExpoProcess: async () => {
      spawnCalls += 1;
      return replacement;
    },
    waitForExpoMetroRunningImpl: async ({ port, ownerPid }) => ({
      ok: true,
      ownerPid,
      listenerPid: ownerPid,
      ownedListenerPids: [ownerPid],
      port,
    }),
    readSpawnedProcessIdentity: async () => ({
      processInstanceFingerprint: 'win32-cim:replacement-process',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(killCalls, 1);
  assert.equal(spawnCalls, 1);
  const publishedState = JSON.parse(await readFile(fixture.paths.statePath, 'utf8'));
  assert.equal(publishedState.pid, replacement.pid);
  assert.equal(publishedState.processInstanceFingerprint, 'win32-cim:replacement-process');
});

test('explicit restart does not spawn when canonical ownership cleanup refuses the live legacy PID', async (t) => {
  const fixture = await createFixture();
  t.after(async () => rm(fixture.tmp, { recursive: true, force: true }));
  let spawnCalls = 0;
  let killCalls = 0;

  await assert.rejects(() => ensureDevExpoServer({
    ...buildBaseOptions({ ...fixture, children: [], restart: true }),
    killOwnedProcessGroup: async () => {
      killCalls += 1;
      return { killed: false, reason: 'ownership_unverified' };
    },
    spawnExpoProcess: async () => {
      spawnCalls += 1;
      return createFakeExpoProcess();
    },
  }), (error) => error?.code === 'EEXPOPIDOWNERSHIPUNVERIFIED');

  assert.equal(killCalls, 1);
  assert.equal(spawnCalls, 0);
});
