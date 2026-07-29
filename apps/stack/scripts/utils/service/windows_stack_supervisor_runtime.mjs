import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { getDefaultAutostartPaths } from '../paths/paths.mjs';
import { killProcessTree, runCapture } from '../proc/proc.mjs';
import { getInternalServerUrl } from '../server/urls.mjs';
import { isPidAlive } from '../stack/runtime_state.mjs';
import { stopStackWithEnv } from '../stack/stop.mjs';
import { collectWindowsStackHealth } from './windows_stack_health.mjs';
import { runWindowsStackSupervisor } from './windows_stack_supervisor.mjs';

export function resolveWindowsStackSupervisorPaths({ baseDir } = {}) {
  const root = String(baseDir ?? '').trim();
  if (!root) throw new Error('[service supervisor] missing base directory');
  return {
    lockPath: join(root, 'windows-supervisor.lock.json'),
    statePath: join(root, 'windows-supervisor.state.json'),
    stopRequestPath: join(root, 'windows-supervisor.stop.json'),
  };
}

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function postDaemonControl({ path, state, timeoutMs, fetchImpl }) {
  const httpPort = Number(state?.httpPort);
  if (!Number.isFinite(httpPort) || httpPort <= 0) return null;
  const headers = { 'content-type': 'application/json' };
  const controlToken = String(state?.controlToken ?? '').trim();
  if (controlToken) headers['x-happier-daemon-token'] = controlToken;
  const response = await fetchImpl(`http://127.0.0.1:${httpPort}${path}`, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  return parseJsonObject(await response.text());
}

function childExitWithin(child, timeoutMs) {
  if (child?.exitCode != null) {
    return Promise.resolve({
      type: 'exit',
      code: child.exitCode,
      signal: child.signalCode ?? null,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.removeListener?.('exit', onExit);
      resolve(value);
    };
    const onExit = (code, signal) => finish({ type: 'exit', code, signal });
    const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
    child?.once?.('exit', onExit);
  });
}

export async function waitForWindowsStackMonitorEvent({
  child,
  generationId,
  healthIntervalMs,
  stopPollMs = 250,
  now = Date.now,
  waitForChildEvent = childExitWithin,
  shouldStopSignal,
  readStopRequest,
  probeHealth,
} = {}) {
  const interval = Math.max(1, Number(healthIntervalMs) || 1);
  const poll = Math.max(1, Math.min(interval, Number(stopPollMs) || 250));
  const deadline = now() + interval;
  while (true) {
    const remaining = Math.max(1, deadline - now());
    const childEvent = await waitForChildEvent(child, Math.min(poll, remaining));
    if (childEvent?.type === 'exit') return childEvent;
    if (shouldStopSignal()) return { type: 'stop_requested', source: 'signal' };

    const stopRequest = await readStopRequest();
    const targetGenerationId = String(stopRequest?.targetGenerationId ?? '').trim();
    if (stopRequest && (!targetGenerationId || targetGenerationId === generationId)) {
      return {
        type: 'stop_requested',
        source: 'request_file',
        requestedBy: String(stopRequest.requestedBy ?? '').trim() || 'windows_service_supervisor',
        stopSessions: stopRequest.stopSessions !== false,
        preserveDaemon: stopRequest.preserveDaemon === true,
      };
    }
    if (now() >= deadline) {
      const health = await probeHealth();
      return health.restartable
        ? { type: 'health_failure', health }
        : { type: 'health_ok', health };
    }
  }
}

export async function requestWindowsStackSupervisorStop({
  baseDir,
  requestedBy = 'service stop',
  reason = 'explicit service stop',
  stopSessions = true,
  preserveDaemon = false,
  now = Date.now,
} = {}) {
  const paths = resolveWindowsStackSupervisorPaths({ baseDir });
  await mkdir(baseDir, { recursive: true });
  const state = await readJsonIfExists(paths.statePath, { defaultValue: null });
  const request = {
    version: 1,
    targetGenerationId: String(state?.generationId ?? '').trim() || null,
    requestedBy: String(requestedBy ?? '').trim() || 'service stop',
    reason: String(reason ?? '').trim() || 'explicit service stop',
    stopSessions: stopSessions !== false,
    preserveDaemon: preserveDaemon === true,
    requestedAt: new Date(now()).toISOString(),
  };
  await writeJsonAtomic(paths.stopRequestPath, request);
  return request;
}

export async function readWindowsStackSupervisorStatus({
  baseDir,
  isPidAliveImpl = isPidAlive,
} = {}) {
  const paths = resolveWindowsStackSupervisorPaths({ baseDir });
  const state = await readJsonIfExists(paths.statePath, { defaultValue: null });
  const lock = await readJsonIfExists(paths.lockPath, { defaultValue: null });
  const supervisorPid = Number(state?.supervisorPid ?? lock?.pid);
  return {
    state,
    lock: lock
      ? {
          pid: Number.isFinite(Number(lock.pid)) ? Number(lock.pid) : null,
          generationId: String(lock.generationId ?? '').trim() || null,
          acquiredAt: String(lock.acquiredAt ?? '').trim() || null,
        }
      : null,
    running: Number.isFinite(supervisorPid) && supervisorPid > 1 ? isPidAliveImpl(supervisorPid) : false,
  };
}

export async function waitForWindowsStackSupervisorStop({
  baseDir,
  timeoutMs = 10_000,
  pollMs = 250,
  now = Date.now,
  sleep = delay,
  isPidAliveImpl = isPidAlive,
} = {}) {
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  let latest = await readWindowsStackSupervisorStatus({ baseDir, isPidAliveImpl });
  while (latest.running && now() < deadline) {
    await sleep(pollMs);
    latest = await readWindowsStackSupervisorStatus({ baseDir, isPidAliveImpl });
  }
  const supervisorPid = Number(latest?.state?.supervisorPid ?? latest?.lock?.pid);
  return {
    stopped: latest.running !== true,
    supervisorPid: Number.isFinite(supervisorPid) && supervisorPid > 1 ? supervisorPid : null,
    state: latest.state,
  };
}

export async function runWindowsStackSupervisorRuntime({
  rootDir,
  baseDir: explicitBaseDir,
  stackName: explicitStackName,
  env = process.env,
  pid = process.pid,
  generationId = randomUUID(),
  now = Date.now,
  isPidAliveImpl = isPidAlive,
  spawnImpl = spawn,
  collectHealthImpl = collectWindowsStackHealth,
  waitForEventImpl = null,
  stopStackWithEnvImpl = stopStackWithEnv,
  runCaptureImpl = runCapture,
  fetchImpl = fetch,
  sleepImpl = delay,
} = {}) {
  const resolvedRootDir = String(rootDir ?? '').trim();
  if (!resolvedRootDir) throw new Error('[service supervisor] missing root directory');
  const defaults = getDefaultAutostartPaths();
  const baseDir = String(explicitBaseDir ?? defaults.baseDir).trim();
  const stackName = String(explicitStackName ?? env.HAPPIER_STACK_STACK ?? defaults.stackName ?? 'main').trim() || 'main';
  const paths = resolveWindowsStackSupervisorPaths({ baseDir });
  await mkdir(baseDir, { recursive: true });

  const previousState = await readJsonIfExists(paths.statePath, { defaultValue: null });
  const initialRestartTimestamps = previousState?.phase !== 'crash_budget_exhausted'
    && Array.isArray(previousState?.restartTimestamps)
    ? previousState.restartTimestamps
    : [];
  let stopSignalRequested = false;
  const requestSignalStop = () => {
    stopSignalRequested = true;
  };
  process.once('SIGINT', requestSignalStop);
  process.once('SIGTERM', requestSignalStop);

  const runtimeEnv = {
    ...env,
    HAPPIER_STACK_SERVICE_MODE: '1',
    HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1',
  };
  const serviceRunMode = String(runtimeEnv.HAPPIER_STACK_SERVICE_RUN_MODE ?? '').trim().toLowerCase() === 'dev'
    ? 'dev'
    : 'start';
  const internalServerUrl = getInternalServerUrl({ env: runtimeEnv, defaultPort: 3005 }).internalServerUrl;
  const uiUrl =
    String(runtimeEnv.HAPPIER_STACK_UI_URL ?? '').trim() ||
    String(runtimeEnv.HAPPIER_WEBAPP_URL ?? '').trim() ||
    (serviceRunMode === 'dev'
      ? `http://127.0.0.1:${positiveInteger(runtimeEnv.HAPPIER_STACK_EXPO_DEV_PORT, 8081)}`
      : '') ||
    internalServerUrl;
  const cliHomeDir =
    String(runtimeEnv.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() ||
    join(baseDir, 'cli');
  const daemonStatePath = resolvePreferredStackDaemonStatePaths({
    cliHomeDir,
    serverUrl: internalServerUrl,
    env: runtimeEnv,
  }).statePath;

  const probeHealth = async () => await collectHealthImpl({
    relayUrl: internalServerUrl,
    uiUrl,
    fetchImpl,
    readDaemonStatus: async () => {
      const output = await runCaptureImpl(
        process.execPath,
        [join(resolvedRootDir, 'scripts', 'happier.mjs'), 'daemon', 'status', '--json'],
        { cwd: resolvedRootDir, env: runtimeEnv, timeoutMs: 5_000 },
      );
      return parseJsonObject(output);
    },
    readDaemonControlState: async () => await readJsonIfExists(daemonStatePath, { defaultValue: null }),
    postDaemonControl: async ({ path, state, timeoutMs }) => await postDaemonControl({
      path,
      state,
      timeoutMs,
      fetchImpl,
    }),
    isPidAliveImpl,
    timeoutMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_PROBE_TIMEOUT_MS, 3_000),
  });

  const startStack = async () => spawnImpl(
    process.execPath,
    serviceRunMode === 'dev'
      ? [join(resolvedRootDir, 'scripts', 'dev.mjs'), '--no-browser']
      : [join(resolvedRootDir, 'scripts', 'run.mjs'), '--restart', '--no-browser'],
    {
      cwd: resolvedRootDir,
      env: runtimeEnv,
      stdio: 'inherit',
      windowsHide: true,
    },
  );

  const stopStack = async (child, context) => {
    let stopError = null;
    try {
      await stopStackWithEnvImpl({
        rootDir: resolvedRootDir,
        stackName,
        baseDir,
        env: runtimeEnv,
        json: true,
        aggressive: context?.stopSessions === true,
        preserveDaemon: context?.preserveDaemon === true,
        autoSweep: true,
      });
    } catch (error) {
      stopError = error;
    } finally {
      if (Number(child?.pid) > 1 && isPidAliveImpl(Number(child.pid))) {
        killProcessTree(child, 'SIGTERM');
      }
    }
    if (stopError) throw stopError;
  };

  const waitForEvent = waitForEventImpl ?? (async ({ child }) => await waitForWindowsStackMonitorEvent({
    child,
    generationId,
    healthIntervalMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_HEALTH_INTERVAL_MS, 15_000),
    stopPollMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_STOP_POLL_MS, 250),
    shouldStopSignal: () => stopSignalRequested,
    readStopRequest: async () => await readJsonIfExists(paths.stopRequestPath, { defaultValue: null }),
    probeHealth,
  }));

  try {
    return await runWindowsStackSupervisor({
      lockPath: paths.lockPath,
      pid,
      generationId,
      now,
      isPidAliveImpl,
      startStack,
      stopStack,
      probeHealth,
      waitForEvent,
      sleep: sleepImpl,
      writeState: async (state) => await writeJsonAtomic(paths.statePath, state),
      maxRestarts: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_MAX_RESTARTS, 3),
      restartWindowMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_RESTART_WINDOW_MS, 5 * 60_000),
      restartBackoffMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_RESTART_BACKOFF_MS, 2_000),
      initialRestartTimestamps,
      startupMaxAttempts: positiveInteger(
        runtimeEnv.HAPPIER_STACK_SUPERVISOR_STARTUP_MAX_ATTEMPTS,
        serviceRunMode === 'dev' ? 300 : 90,
      ),
      startupPollMs: positiveInteger(runtimeEnv.HAPPIER_STACK_SUPERVISOR_STARTUP_POLL_MS, 1_000),
    });
  } finally {
    process.removeListener('SIGINT', requestSignalStop);
    process.removeListener('SIGTERM', requestSignalStop);
    await rm(paths.stopRequestPath, { force: true }).catch(() => {});
  }
}
