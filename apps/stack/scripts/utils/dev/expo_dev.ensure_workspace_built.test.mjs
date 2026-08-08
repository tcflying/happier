import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';

test('ensureDevExpoServer runs the UI workspace build preflight before starting Expo', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-preflight-'));
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'scripts'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const marker = join(tmp, 'workspace-preflight-ran.txt');
    await writeFile(join(uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'ok\\n', 'utf-8');`,
    ].join('\n') + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const { binDir } = writeFakeBin({
      root: tmp,
      name: 'lsof',
      content: `#!/bin/sh
port=''
for arg in "$@"; do case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac; done
owner_file="\${TEST_EXPO_LISTENER_DIR:-}/listener-$port"
if [ -f "$owner_file" ]; then /bin/cat "$owner_file"; exit 0; fi
exit 1
`,
    });
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        "console.log(fs.existsSync(marker) ? 'preflight-ok' : 'preflight-missing');",
        "const http = require('node:http');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(port, '127.0.0.1', () => fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid)));",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const teeFile = join(tmp, 'expo.log');
    const children = [];
    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildStackHarnessEnv({
        baseEnv: buildStackFixtureEnv({ baseEnv: process.env, stripStackEnv: true }),
        binDirs: [binDir],
        extraEnv: {
          HAPPIER_STACK_VERBOSE: '1',
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          TEST_EXPO_LISTENER_DIR: tmp,
        },
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: true,
      stackMode: false,
      runtimeStatePath: null,
      stackName: 'test',
      envPath: '',
      children,
      spawnOptions: {
        silent: true,
        teeFile,
        teeLabel: 'expo',
      },
      quiet: true,
    });

    const deadlineMs = Date.now() + 3000;
    let log = '';
    while (Date.now() < deadlineMs) {
      log = await readFile(teeFile, 'utf-8').catch(() => '');
      if (/preflight-/.test(log)) break;
      await delay(100);
    }

    assert.match(log, /preflight-ok/);
    result.proc.kill('SIGKILL');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

async function writeRunningExpoState({ tmp, uiDir, apiServerUrl }) {
  const paths = getExpoStatePaths({
    baseDir: tmp,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  await writePidState(paths.statePath, {
    pid: process.pid,
    processInstanceFingerprint: 'win32-cim:test-running-expo',
    port: 8081,
    uiDir,
    projectDir: uiDir,
    startedAt: new Date().toISOString(),
    webEnabled: true,
    devClientEnabled: false,
    host: 'lan',
    apiServerUrl,
  });
  return paths;
}

test('automatic API URL restart preserves the running Metro when workspace preflight fails', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-preflight-preserve-'));
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'scripts'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const marker = join(tmp, 'workspace-preflight-failed.txt');
    await writeFile(join(uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'attempted\\n', 'utf-8');`,
      'process.exitCode = 42;',
    ].join('\n') + '\n', 'utf-8');
    await writeRunningExpoState({ tmp, uiDir, apiServerUrl: 'http://127.0.0.1:3012' });

    let stopCalls = 0;
    await assert.rejects(
      ensureDevExpoServer({
        startUi: true,
        startMobile: false,
        uiDir,
        autostart: { baseDir: tmp },
        baseEnv: buildStackFixtureEnv({ baseEnv: process.env, stripStackEnv: true }),
        apiServerUrl: 'http://127.0.0.1:3014',
        restart: false,
        stackMode: true,
        runtimeStatePath: null,
        stackName: 'preflight-preserve-test',
        envPath: join(tmp, 'stack.env'),
        children: [],
        quiet: true,
        readStateProcessIdentityLine: async () => `node ${uiDir}`,
        killOwnedProcessGroup: async () => {
          stopCalls += 1;
          return { killed: true, reason: 'test_boundary' };
        },
      }),
      /failed \(code=42\)/,
    );

    assert.equal(await readFile(marker, 'utf-8'), 'attempted\n');
    assert.equal(stopCalls, 0, 'failed preflight must not stop the currently running Metro');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('automatic API URL restart completes workspace preflight before stopping the running Metro', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-preflight-before-stop-'));
  let result = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'scripts'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const marker = join(tmp, 'workspace-preflight-succeeded.txt');
    await writeFile(join(uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'prepared\\n', 'utf-8');`,
    ].join('\n') + '\n', 'utf-8');

    const { binDir } = writeFakeBin({
      root: tmp,
      name: 'lsof',
      content: `#!/bin/sh
port=''
for arg in "$@"; do case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac; done
owner_file="\${TEST_EXPO_LISTENER_DIR:-}/listener-$port"
if [ -f "$owner_file" ]; then /bin/cat "$owner_file"; exit 0; fi
exit 1
`,
    });
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      'const port = Number(process.env.RCT_METRO_PORT);',
      "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(port, '127.0.0.1', () => fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid)));",
    ].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);
    await writeRunningExpoState({ tmp, uiDir, apiServerUrl: 'http://127.0.0.1:3012' });

    let stopCalls = 0;
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildStackHarnessEnv({
        baseEnv: buildStackFixtureEnv({ baseEnv: process.env, stripStackEnv: true }),
        binDirs: [binDir],
        extraEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          TEST_EXPO_LISTENER_DIR: tmp,
        },
      }),
      apiServerUrl: 'http://127.0.0.1:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'preflight-before-stop-test',
      envPath: join(tmp, 'stack.env'),
      children: [],
      spawnOptions: { silent: true },
      quiet: true,
      readStateProcessIdentityLine: async () => `node ${uiDir}`,
      killOwnedProcessGroup: async () => {
        assert.equal(await readFile(marker, 'utf-8'), 'prepared\n');
        stopCalls += 1;
        return { killed: true, reason: 'test_boundary' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(stopCalls, 1);
  } finally {
    await result?.proc?.kill?.('SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  }
});
