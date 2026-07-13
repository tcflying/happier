import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmSpawnScript } from '../proc/pm.mjs';
import { killProcessTree, run } from '../proc/proc.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { applyServerLightEnvDefaults } from '../server/apply_server_light_env_defaults.mjs';
import { resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { applyStackServerLoggingDefaults } from '../server/logging_env.mjs';
import { resolveServerReadyTimeoutMs, waitForServerReady } from '../server/server.mjs';
import { isTcpPortFree, listListenPids, listListenPidsWithStatus, pickNextFreeTcpPort, waitForTcpPortFree } from '../net/ports.mjs';
import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { getProcessGroupId, isPidOwnedByStack, killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { isWindowsPidDescendantOf } from '../proc/windows_process_tree.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';

function readPackageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function hasPackageScript(dir, scriptName) {
  const script = readPackageScripts(dir)?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

function resolveDevServerWatchPaths({ serverDir, existsSyncImpl = existsSync }) {
  const repoRoot = resolve(serverDir, '..', '..');
  const sharedPackages = ['agents', 'cli-common', 'protocol'];
  const serverPaths = [
    join(serverDir, 'sources'),
    join(serverDir, 'scripts'),
    join(serverDir, 'prisma'),
    join(serverDir, 'package.json'),
    join(serverDir, 'tsconfig.json'),
    join(serverDir, 'tsconfig.build.json'),
  ];
  const sharedPaths = sharedPackages.flatMap((pkg) => ([
    join(repoRoot, 'packages', pkg, 'src'),
    join(repoRoot, 'packages', pkg, 'package.json'),
    join(repoRoot, 'packages', pkg, 'tsconfig.json'),
  ]));

  return [...serverPaths, ...sharedPaths].filter((p) => existsSyncImpl(p));
}

function appendWatchSignatureEntries(path, entries) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    let names = [];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort();
    } catch {
      return true;
    }
    for (const name of names) {
      appendWatchSignatureEntries(join(path, name), entries);
    }
    return true;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    entries.push(`${path}\0file\0${stats.size}\0${Math.trunc(stats.mtimeMs)}`);
    return true;
  }

  entries.push(`${path}\0other\0${Math.trunc(stats.mtimeMs)}`);
  return true;
}

function readDevServerWatchChangeSignature(paths) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = appendWatchSignatureEntries(path, entries) || observed;
  }
  return observed ? entries.join('\n') : null;
}

export async function resolveStackOwnedServerListenPid(
  { serverPort, stackName, envPath },
  {
    listListenPidsImpl = listListenPids,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {},
) {
  const listenPids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => []);
  if (!listenPids.length) return null;

  let expectedPgid = null;
  for (const pid of listenPids) {
    // eslint-disable-next-line no-await-in-loop
    const owned = await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false);
    if (!owned) {
      return null;
    }

    // eslint-disable-next-line no-await-in-loop
    const pgid = await getProcessGroupIdImpl(pid).catch(() => null);
    if (!pgid) {
      if (listenPids.length > 1) {
        return null;
      }
      continue;
    }
    if (!expectedPgid) {
      expectedPgid = pgid;
    } else if (pgid !== expectedPgid) {
      return null;
    }
  }
  return listenPids[0] ?? null;
}

async function readListenPidsForOwnership({
  serverPort,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
}) {
  if (typeof listListenPidsWithStatusImpl === 'function' && listListenPidsImpl === listListenPids) {
    const out = await listListenPidsWithStatusImpl(serverPort, { timeoutMs: 1000 }).catch((error) => ({
      supported: false,
      pids: [],
      reason: error instanceof Error ? error.message : 'listener-discovery-error',
    }));
    return {
      supported: out?.supported !== false,
      pids: Array.isArray(out?.pids) ? out.pids : [],
      reason: out?.reason,
    };
  }

  const pids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => null);
  return {
    supported: Array.isArray(pids),
    pids: Array.isArray(pids) ? pids : [],
    reason: Array.isArray(pids) ? undefined : 'listener-discovery-error',
  };
}

async function assertServerPortOwnedBySpawnedProcessGroup({
  serverPort,
  spawnedPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  platform = process.platform,
  isWindowsPidDescendantOfImpl = isWindowsPidDescendantOf,
}) {
  const rootPid = Number(spawnedPid);
  const listenResult = await readListenPidsForOwnership({
    serverPort,
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  if (!listenResult.supported) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: listener discovery unavailable` +
        (listenResult.reason ? ` (${listenResult.reason})` : '')
    );
  }

  const listenPids = listenResult.pids;
  if (!listenPids.length) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: no listener PID was discovered`
    );
  }

  let rootPgid = null;

  for (const listenPid of listenPids) {
    if (Number(listenPid) === rootPid) {
      continue;
    }
    if (platform === 'win32') {
      // eslint-disable-next-line no-await-in-loop
      const isDescendant = await isWindowsPidDescendantOfImpl(Number(listenPid), rootPid).catch(() => false);
      if (!isDescendant) {
        throw new Error(
          `[local] server readiness was answered by another process on port ${serverPort}; ` +
            `spawned pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
        );
      }
      continue;
    }
    if (!rootPgid) {
      // eslint-disable-next-line no-await-in-loop
      rootPgid = await getProcessGroupIdImpl(spawnedPid).catch(() => null);
      if (!rootPgid) {
        throw new Error(
          `[local] server readiness ownership could not be proven on port ${serverPort}: ` +
            `process group unavailable for pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const listenPgid = await getProcessGroupIdImpl(listenPid).catch(() => null);
    if (!listenPgid || listenPgid !== rootPgid) {
      throw new Error(
        `[local] server readiness was answered by another process on port ${serverPort}; ` +
          `spawned pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
      );
    }
  }
}

async function isServerPortOwnedByProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  platform = process.platform,
  isWindowsPidDescendantOfImpl = isWindowsPidDescendantOf,
}) {
  try {
    await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: rootPid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      platform,
      isWindowsPidDescendantOfImpl,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveStackOwnedServerRuntimePid(
  { runtimeStatePath, serverPort, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {}
) {
  const state = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const runtimePid = Number(state?.processes?.serverPid);
  if (Number.isFinite(runtimePid) && runtimePid > 1 && isPidAliveImpl(runtimePid)) {
    const owned = await isPidOwnedByStackImpl(runtimePid, { stackName, envPath }).catch(() => false);
    if (
      owned &&
      (await isServerPortOwnedByProcessGroup({
        serverPort,
        rootPid: runtimePid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
      }))
    ) {
      return runtimePid;
    }
  }

  const listenPid = await resolveStackOwnedServerListenPidImpl({ serverPort, stackName, envPath });
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1 ? Number(listenPid) : null;
}

export async function stopStackOwnedServerForRestart(
  { serverPort, runtimeStatePath, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    isTcpPortFreeImpl = isTcpPortFree,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
    waitForTcpPortFreeImpl = waitForTcpPortFree,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {}
) {
  const st = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const pid = Number(st?.processes?.serverPid);
  let stopPid = null;
  let recordedPidAliveAndOwned = false;

  if (pid > 1 && isPidAliveImpl(pid)) {
    const owned = await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false);
    recordedPidAliveAndOwned = owned;
    if (
      owned &&
      (await isServerPortOwnedByProcessGroup({
        serverPort,
        rootPid: pid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
      }))
    ) {
      stopPid = pid;
    }
  }

  if (!stopPid) {
    const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
    if (!free) {
      const listenPid = await resolveStackOwnedServerListenPidImpl(
        { serverPort, stackName, envPath },
        { listListenPidsImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl }
      );
      if (!(Number.isFinite(Number(listenPid)) && Number(listenPid) > 1)) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }

      stopPid = Number(listenPid);
      await recordStackRuntimeUpdateImpl(runtimeStatePath, { processes: { serverPid: Number(listenPid) } }).catch(() => {});
    } else if (recordedPidAliveAndOwned) {
      throw new Error(
        `[local] restart refused: recorded server pid ${pid} is still alive, but server port ${serverPort} has no listener proof for it.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  if (stopPid) {
    const res = await killProcessGroupOwnedByStackImpl(Number(stopPid), {
      stackName,
      envPath,
      label: 'server',
      json: true,
    });
    if (!res?.killed) {
      throw new Error(
        `[local] restart refused: server port ${serverPort} is occupied by a process that could not be stopped safely.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
  if (!released) {
    throw new Error(`[local] restart refused: server port ${serverPort} did not release after stopping the previous server.`);
  }
}

function removeChildFromChildren(children, child) {
  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

function hasChildExited(child) {
  return (
    (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined)
  );
}

async function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) return true;
  if (!child || typeof child.once !== 'function') return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeout = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise(value);
    };

    timeout = setTimeout(() => done(false), timeoutMs);
    child.once('exit', () => done(true));
    child.once('close', () => done(true));
  });
}

function signalSpawnedProcessGroup(child, signal) {
  const pid = Number(child?.pid);
  if (Number.isFinite(pid) && pid > 1) {
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, signal);
      } else {
        child.kill?.(signal);
      }
      return;
    } catch {
      // Fall back to ChildProcess.kill below.
    }
  }
  try {
    child?.kill?.(signal);
  } catch {
    // ignore
  }
}

async function terminateSpawnedChildForCleanup(
  child,
  {
    killSpawnedChildImpl = killProcessTree,
    signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
    gracefulMs = 800,
    forceMs = 300,
  } = {}
) {
  if (!child) return true;

  try {
    signalSpawnedProcessGroupImpl(child, 'SIGTERM');
  } catch {
    try {
      killSpawnedChildImpl(child, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  if (hasChildExited(child)) return true;
  if (await waitForChildExit(child, gracefulMs)) return true;

  try {
    signalSpawnedProcessGroupImpl(child, 'SIGKILL');
  } catch {
    try {
      killSpawnedChildImpl(child, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  return await waitForChildExit(child, forceMs);
}

async function cleanupStackSpawnedChild({
  child,
  children,
  authoritativeChild = null,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  stackName,
  envPath,
}) {
  if (!child || authoritativeChild === child) return;
  const pid = Number(child?.pid);
  if (!Number.isFinite(pid) || pid <= 1) {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, signalSpawnedProcessGroupImpl }));
    if (terminated) {
      removeChildFromChildren(children, child);
    }
    return;
  }

  const res = await killProcessGroupOwnedByStackImpl(pid, {
    stackName,
    envPath,
    label: 'server',
    json: false,
  }).catch(() => ({ killed: false }));
  if (!res?.killed || res?.reason === 'killed_pid_only') {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, signalSpawnedProcessGroupImpl }));
    if (!terminated) return;
  }
  removeChildFromChildren(children, child);
}

export async function preflightDevServerRestart(
  { serverDir, serverEnv = {}, logger = console },
  { runImpl = run } = {},
) {
  const enabled = String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT ?? '').trim() !== '0';
  if (!enabled) return { ran: false, reason: 'disabled' };
  if (String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE ?? '').trim() === '1') {
    return { ran: false, reason: 'already-done' };
  }
  if (!hasPackageScript(serverDir, 'build')) return { ran: false, reason: 'missing-build-script' };

  logger.log('[local] watch: server changed → preflight build...');
  await runImpl('yarn', ['-s', 'build'], {
    cwd: serverDir,
    env: {
      ...serverEnv,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: serverEnv.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '1',
    },
    stdio: 'inherit',
  });
  return { ran: true, reason: 'build-ok' };
}

export function resolveStackUiDevPortStart({ env = process.env, stackName }) {
  return resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_UI_DEV_PORT_BASE: (env.HAPPIER_STACK_UI_DEV_PORT_BASE ?? '8081').toString(),
      HAPPIER_STACK_UI_DEV_PORT_RANGE: (env.HAPPIER_STACK_UI_DEV_PORT_RANGE ?? '1000').toString(),
    },
    stackName,
    baseKey: 'HAPPIER_STACK_UI_DEV_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_UI_DEV_PORT_RANGE',
    defaultBase: 8081,
    defaultRange: 1000,
  });
}

export async function pickDevMetroPort({ startPort, reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  const forcedPort = (process.env.HAPPIER_STACK_UI_DEV_PORT ?? '').toString().trim();
  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function startDevServer({
  serverComponentName,
  serverDir,
  autostart,
  baseEnv,
  serverPort,
  internalServerUrl,
  publicServerUrl,
  envPath,
  stackMode,
  runtimeStatePath,
  serverAlreadyRunning,
  restart,
  children,
  spawnOptions = {},
  quiet = false,
}, {
  ensureDepsInstalledImpl = ensureDepsInstalled,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  platform = process.platform,
  isWindowsPidDescendantOfImpl = isWindowsPidDescendantOf,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
} = {}) {
  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };
  applyStackServerLoggingDefaults({ baseEnv, serverEnv });

  if (serverComponentName === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir: autostart.baseDir });
  }

  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const infra = await ensureHappyServerManagedInfra({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: baseEnv,
      });
      Object.assign(serverEnv, infra.env);
    }

    const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrations({ serverDir, env: serverEnv });
    }
  }

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalledImpl(serverDir, serverComponentName, { quiet, env: serverEnv });

  const prismaPush = (baseEnv.HAPPIER_STACK_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state.
  if (restart && stackMode && runtimeStatePath) {
    await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger: console });
    await stopStackOwnedServerForRestartImpl(
      {
        serverPort,
        runtimeStatePath,
        stackName: autostart.stackName,
        envPath,
      },
      { killProcessGroupOwnedByStackImpl, recordStackRuntimeUpdateImpl }
    );
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  const server = await pmSpawnScriptImpl({
    label: 'server',
    dir: serverDir,
    script: serverScript,
    env: serverEnv,
    options: spawnOptions,
    quiet,
  });
  children.push(server);
  try {
    await waitForServerReadyImpl(internalServerUrl, {
      timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
      childProcess: server,
    });
    await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: server.pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
      platform,
      isWindowsPidDescendantOfImpl,
    });
    if (hasChildExited(server)) {
      throw new Error(
        `[local] server process exited after readiness check ` +
          `(pid=${server.pid}, code=${server.exitCode ?? 'null'}, signal=${server.signalCode ?? 'null'})`
      );
    }
  } catch (error) {
    await cleanupStackSpawnedChild({
      child: server,
      children,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      signalSpawnedProcessGroupImpl,
      terminateSpawnedChildImpl,
      stackName: autostart.stackName,
      envPath,
    });
    throw error;
  }
  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeUpdateImpl(runtimeStatePath, { processes: { serverPid: server.pid } }).catch(() => {});
  }
  return { serverEnv, serverScript, serverProc: server };
}

export function watchDevServerAndRestart({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
  platform = process.platform,
}, {
  watchDebouncedImpl = watchDebounced,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  isTcpPortFreeImpl = isTcpPortFree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  pmSpawnScriptImpl = pmSpawnScript,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  isWindowsPidDescendantOfImpl = isWindowsPidDescendantOf,
  isPidAliveImpl = isPidAlive,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  readWatchChangeSignatureImpl = readDevServerWatchChangeSignature,
  existsSyncImpl = existsSync,
  logger = console,
} = {}) {
  if (!enabled) return null;

  // Both server flavors are spawned through plain tsx dev scripts; stack watch owns source-change restarts.
  if (serverComponentName !== 'happier-server' && serverComponentName !== 'happier-server-light') return null;

  let inFlight = false;
  let pending = false;
  const watchPaths = resolveDevServerWatchPaths({ serverDir, existsSyncImpl });
  let lastWatchSignature = readWatchChangeSignatureImpl(watchPaths);

  const cleanupProvisionalChild = async (child) => {
    await cleanupStackSpawnedChild({
      child,
      children,
      authoritativeChild: serverProcRef.current,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      signalSpawnedProcessGroupImpl,
      terminateSpawnedChildImpl,
      stackName,
      envPath,
    });
  };

  const hasRealWatchedChange = () => {
    const nextWatchSignature = readWatchChangeSignatureImpl(watchPaths);
    if (lastWatchSignature && nextWatchSignature && nextWatchSignature === lastWatchSignature) {
      return false;
    }
    if (nextWatchSignature) {
      lastWatchSignature = nextWatchSignature;
    }
    return true;
  };

  const restartOnce = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger });

    logger.log('[local] watch: server preflight passed → restarting...');
    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
      platform,
      isWindowsPidDescendantOfImpl,
    });
    if (ownsCurrentListener) {
      const killResult = await killProcessGroupOwnedByStackImpl(pid, { stackName, envPath, label: 'server', json: false });
      if (!killResult.killed) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    } else {
      const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} is still alive, but port ${serverPort} has no listener proof for it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      if (!free) {
        throw new Error(
          `[local] watch restart refused: server port ${serverPort} is occupied and the running PID does not own it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    }
    const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
    if (!released) {
      throw new Error(`[local] watch restart refused: server port ${serverPort} did not release after stopping pid=${pid}.`);
    }

    let next = null;
    try {
      next = await pmSpawnScriptImpl({ label: 'server', dir: serverDir, script: serverScript, env: serverEnv });
      children.push(next);
      await waitForServerReadyImpl(internalServerUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: next,
      });
      await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort,
        spawnedPid: next.pid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
        platform,
        isWindowsPidDescendantOfImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
    } catch (error) {
      await cleanupProvisionalChild(next);
      throw error;
    }
    serverProcRef.current = next;
    if (stackMode && runtimeStatePath) {
      await recordStackRuntimeUpdateImpl(runtimeStatePath, { processes: { serverPid: next.pid } }).catch(() => {});
    }
    logger.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
    return true;
  };

  return watchDebouncedImpl({
    paths: (watchPaths.length ? watchPaths : [serverDir]).map((p) => resolve(p)),
    debounceMs: 600,
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (!hasRealWatchedChange()) return;
      if (inFlight) {
        pending = true;
        return;
      }

      inFlight = true;
      try {
        do {
          pending = false;
          if (isShuttingDown?.()) return;
          try {
            const restarted = await restartOnce();
            if (!restarted) break;
          } catch (e) {
            const msg = e instanceof Error ? e.stack || e.message : String(e);
            logger.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
            logger.error(msg);
            if (pending) continue;
            break;
          }
        } while (pending);
      } finally {
        inFlight = false;
      }
    },
  });
}
