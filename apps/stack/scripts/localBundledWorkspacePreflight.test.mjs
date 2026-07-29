import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { coerceHappyMonorepoRootFromPath } from './utils/paths/paths.mjs';
import {
  reclaimWorkspaceBundleLockIfStale,
  releaseWorkspaceBundleLock,
} from './utils/workspaces/workspaceBundleLock.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('workspace bundle lock release closes the descriptor before unlinking the lock file', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'workspace-bundle-lock-release-'));
  const lockPath = join(fixtureDir, 'bundle.lock');
  let fd = null;
  try {
    fd = openSync(lockPath, 'wx');
    const owner = {
      pid: process.pid,
      createdAtMs: Date.now(),
      token: `test-token-${process.pid}`,
    };
    const serializedOwner = JSON.stringify(owner);
    writeSync(fd, serializedOwner, 0, 'utf8');
    ftruncateSync(fd, Buffer.byteLength(serializedOwner));

    const events = [];
    releaseWorkspaceBundleLock(lockPath, fd, owner, {
      closeSync(fdToClose) {
        events.push('close');
        closeSync(fdToClose);
      },
      unlinkSync(pathToRemove) {
        events.push('unlink');
        unlinkSync(pathToRemove);
      },
    });
    fd = null;

    assert.deepEqual(events, ['close', 'unlink']);
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (fd != null) closeSync(fd);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('workspace bundle stale reclaim does not unlink a successor owner lock', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'workspace-bundle-lock-reclaim-successor-'));
  const lockPath = join(fixtureDir, 'bundle.lock');
  try {
    const staleOwner = {
      createdAtMs: Date.now() - 60_000,
      token: 'stale-owner',
    };
    const successorOwner = {
      pid: process.pid,
      createdAtMs: Date.now(),
      token: 'successor-owner',
    };
    writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

    let readCount = 0;
    const reclaimed = reclaimWorkspaceBundleLockIfStale(lockPath, {
      staleAfterMs: 1_000,
      nowMs: Date.now(),
      operations: {
        statSync,
        readFileSync(pathToRead, encoding) {
          readCount += 1;
          const contents = readFileSync(pathToRead, encoding);
          if (readCount === 1) {
            writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
          }
          return contents;
        },
        unlinkSync,
      },
    });

    assert.equal(reclaimed, false);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), successorOwner);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when the monorepo sync helper is unavailable', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-fallback-'));
  try {
    const markerPath = join(fixtureDir, 'bundle.json');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'export async function bundleWorkspaceDeps(opts) {',
        `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        '  return null;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const moduleHref = pathToFileURL(modulePath).href;
    const res = await runNodeCapture(
      ['--input-type=module', '-e', `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(moduleHref)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_OPTIONS: `--experimental-loader=${pathToFileURL(loaderPath).href}`,
        },
      },
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const options = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(options.repoRoot, repoRoot);
    assert.equal(options.stackDir, rootDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight validates external vendored dependencies after monorepo sync', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-vendored-deps-'));
  try {
    const syncMarkerPath = join(fixtureDir, 'sync.marker');
    const bundleMarkerPath = join(fixtureDir, 'bundle.marker');
    const syncStubPath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      syncStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'export function syncBundledWorkspacePackages() {',
        `  writeFileSync(${JSON.stringify(syncMarkerPath)}, 'synced', 'utf8');`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'export async function bundleWorkspaceDeps() {',
        `  writeFileSync(${JSON.stringify(bundleMarkerPath)}, 'validated', 'utf8');`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        `  return ${JSON.stringify(syncStubPath)};`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const moduleHref = pathToFileURL(modulePath).href;
    const res = await runNodeCapture(
      ['--input-type=module', '-e', `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(moduleHref)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_OPTIONS: `--experimental-loader=${pathToFileURL(loaderPath).href}`,
        },
      },
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), true, 'expected monorepo workspace sync to run');
    assert.equal(existsSync(bundleMarkerPath), true, 'expected external vendored dependencies to be validated');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight is importable from a published stack package outside a monorepo', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const packageRoot = mkdtempSync(join(tmpdir(), 'happier-stack-published-preflight-'));
  try {
    const publishedFiles = [
      'bin/localBundledWorkspacePreflight.mjs',
      'scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs',
      'scripts/utils/paths/canonical_home.mjs',
      'scripts/utils/paths/paths.mjs',
      'scripts/utils/workspaces/workspaceBundleLock.mjs',
    ];

    for (const relPath of publishedFiles) {
      const sourcePath = join(rootDir, relPath);
      const targetPath = join(packageRoot, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, targetPath);
      }
    }

    const modulePath = join(packageRoot, 'bin', 'localBundledWorkspacePreflight.mjs');
    const moduleHref = pathToFileURL(modulePath).href;
    const res = await runNodeCapture(
      [
        '--input-type=module',
        '-e',
        `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(moduleHref)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(packageRoot)});`,
      ],
      { cwd: packageRoot },
    );

    assert.equal(res.code, 0, `expected importable preflight no-op, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

function runPreflightProcess({ modulePath, rootDir, loaderPath }) {
  const moduleHref = pathToFileURL(modulePath).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(moduleHref)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`,
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--experimental-loader=${pathToFileURL(loaderPath).href}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('local bundled workspace preflight serializes monorepo sync helper refreshes', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-lock-'));
  try {
    const activePath = join(fixtureDir, 'active');
    const overlapPath = join(fixtureDir, 'overlap');
    const syncStubPath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      syncStubPath,
      [
        "import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';",
        '',
        'function sleepSync(ms) {',
        '  const arr = new Int32Array(new SharedArrayBuffer(4));',
        '  Atomics.wait(arr, 0, 0, ms);',
        '}',
        '',
        'export function syncBundledWorkspacePackages() {',
        '  let fd = null;',
        '  try {',
        `    fd = openSync(${JSON.stringify(activePath)}, 'wx');`,
        "    writeFileSync(fd, String(process.pid), 'utf8');",
        '  } catch (error) {',
        "    if (error?.code !== 'EEXIST') throw error;",
        `    writeFileSync(${JSON.stringify(overlapPath)}, 'overlap', 'utf8');`,
        '  }',
        '  sleepSync(350);',
        '  if (fd !== null) {',
        '    closeSync(fd);',
        `    rmSync(${JSON.stringify(activePath)}, { force: true });`,
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        `  return ${JSON.stringify(syncStubPath)};`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const [first, second] = await Promise.all([
      runPreflightProcess({ modulePath, rootDir, loaderPath }),
      runPreflightProcess({ modulePath, rootDir, loaderPath }),
    ]);

    assert.equal(first.code, 0, `first preflight failed\nstderr:\n${first.stderr}\nstdout:\n${first.stdout}`);
    assert.equal(second.code, 0, `second preflight failed\nstderr:\n${second.stderr}\nstdout:\n${second.stdout}`);
    assert.equal(existsSync(overlapPath), false, 'expected preflight refreshes to be serialized');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
