import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sanitizeRuntimeLogText } from '../../stack/scripts/utils/proc/rotating_log_sink.mjs';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(uiDir, '..', '..');
const expoCliPath = resolve(repoRoot, 'node_modules', 'expo', 'bin', 'cli');
const metroConfigPath = resolve(uiDir, 'metro.config.js');

function readArgument(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const match = argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function boundedAppend(existing, chunk, maxCharacters = 512_000) {
  const combined = `${existing}${String(chunk ?? '')}`;
  return combined.length <= maxCharacters ? combined : combined.slice(-maxCharacters);
}

function safeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeRuntimeLogText(message).slice(0, 4000);
}

function safeOutputTail(output, maxCharacters = 8000) {
  const sanitized = sanitizeRuntimeLogText(output).trim();
  return sanitized ? sanitized.slice(-maxCharacters) : null;
}

function extractEnoentBasenames(output) {
  const values = [];
  const pattern = /ENOENT:\s+no such file or directory, open '([^']+)'/giu;
  for (const match of String(output ?? '').matchAll(pattern)) {
    const value = sanitizeRuntimeLogText(basename(match[1] ?? '')).trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 10);
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function markerSource(marker) {
  return [
    'declare global {',
    '  interface Window { __HAPPIER_HMR_SOAK_MARKER__?: string; }',
    '}',
    `export const HAPPIER_HMR_SOAK_MARKER = ${JSON.stringify(marker)};`,
    'if (typeof window !== "undefined") {',
    '  window.__HAPPIER_HMR_SOAK_MARKER__ = HAPPIER_HMR_SOAK_MARKER;',
    '}',
    'if (typeof module !== "undefined" && module.hot) module.hot.accept();',
    '',
  ].join('\n');
}

function sampleWindowsProcess(processId) {
  if (process.platform !== 'win32') return null;
  const command = (
    `$p = Get-Process -Id ${processId} -ErrorAction Stop; `
    + '[pscustomobject]@{'
    + 'pid=$p.Id;'
    + 'handleCount=$p.HandleCount;'
    + 'workingSetBytes=$p.WorkingSet64;'
    + 'cpuSeconds=$p.CPU'
    + '} | ConvertTo-Json -Compress'
  );
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    shell: false,
    timeout: 20_000,
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout ?? '').trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function normalizeProcessRows(rows) {
  const values = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return values
    .map((row) => ({
      pid: Number(row.ProcessId ?? row.pid),
      parentPid: Number(row.ParentProcessId ?? row.parentPid),
      name: String(row.Name ?? row.name ?? ''),
      createdAtMs: (() => {
        const raw = row.CreationDate ?? row.createdAtMs;
        if (Number.isFinite(Number(raw))) return Number(raw);
        const dotNetDate = String(raw ?? '').match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/u);
        if (dotNetDate) return Number(dotNetDate[1]);
        const parsed = Date.parse(String(raw ?? ''));
        return Number.isFinite(parsed) ? parsed : null;
      })(),
    }))
    .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}

export function selectProcessTree(rows, rootPid, expectedRootCreatedAtMs = null) {
  const childrenByParent = new Map();
  const byPid = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const children = childrenByParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.parentPid, children);
  }

  const selected = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const processId = pending.shift();
    if (seen.has(processId)) continue;
    seen.add(processId);
    const row = byPid.get(processId);
    const parentCreatedAtMs = row?.createdAtMs
      ?? (processId === rootPid ? expectedRootCreatedAtMs : null);
    const rootIdentityMatches = (
      processId !== rootPid
      || !Number.isFinite(expectedRootCreatedAtMs)
      || !Number.isFinite(row?.createdAtMs)
      || row.createdAtMs === expectedRootCreatedAtMs
    );
    if (row && rootIdentityMatches) selected.push(row);
    for (const childPid of childrenByParent.get(processId) ?? []) {
      const child = byPid.get(childPid);
      if (
        Number.isFinite(parentCreatedAtMs)
        && Number.isFinite(child?.createdAtMs)
        && child.createdAtMs < parentCreatedAtMs
      ) {
        continue;
      }
      pending.push(childPid);
    }
  }
  return selected;
}

function captureProcessTree(
  rootPid,
  expectedRootCreatedAtMs = null,
  trackedProcesses = [],
) {
  const sampledAt = new Date().toISOString();
  if (!rootPid) {
    return { rootPid: null, sampledAt, processes: [] };
  }

  const command = process.platform === 'win32'
    ? {
        executable: 'powershell.exe',
        args: [
          '-NoProfile',
          '-Command',
          'Get-CimInstance -ClassName Win32_Process '
            + '| Select-Object ProcessId,ParentProcessId,Name,CreationDate '
            + '| ConvertTo-Json -Compress',
        ],
        parse(stdout) {
          return normalizeProcessRows(JSON.parse(stdout));
        },
      }
    : {
        executable: 'ps',
        args: ['-eo', 'pid=,ppid=,comm='],
        parse(stdout) {
          return String(stdout)
            .split(/\r?\n/u)
            .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u))
            .filter(Boolean)
            .map((match) => ({
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              name: match[3],
            }));
        },
      };

  const result = spawnSync(command.executable, command.args, {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      rootPid,
      sampledAt,
      processes: [],
      error: safeFailure(result.error ?? result.stderr ?? `process inventory exited ${result.status}`),
    };
  }

  try {
    const rows = command.parse(String(result.stdout ?? '').trim());
    const selectedByPid = new Map(
      selectProcessTree(rows, rootPid, expectedRootCreatedAtMs)
        .map((row) => [row.pid, row]),
    );
    for (const tracked of trackedProcesses) {
      const current = rows.find((row) => row.pid === tracked.pid);
      if (!current) continue;
      const identityMatches = (
        !Number.isFinite(current.createdAtMs)
        || !Number.isFinite(tracked.createdAtMs)
        || current.createdAtMs === tracked.createdAtMs
      );
      if (identityMatches) selectedByPid.set(current.pid, current);
    }
    return {
      rootPid,
      sampledAt,
      processes: [...selectedByPid.values()],
    };
  } catch (error) {
    return {
      rootPid,
      sampledAt,
      processes: [],
      error: safeFailure(error),
    };
  }
}

function stopCapturedProcessTrees(snapshot, stopFn) {
  const processes = snapshot?.processes ?? [];
  const capturedPids = new Set(processes.map((entry) => entry.pid));
  const targets = processes.filter((entry) => !capturedPids.has(entry.parentPid));
  const results = targets.map((entry) => {
    try {
      return {
        pid: entry.pid,
        createdAtMs: entry.createdAtMs,
        ...stopFn({ pid: entry.pid, exitCode: null }),
      };
    } catch (error) {
      return {
        pid: entry.pid,
        createdAtMs: entry.createdAtMs,
        requested: true,
        reason: 'cleanup_threw',
        error: safeFailure(error),
      };
    }
  });
  const firstFailure = results.find((result) => result.error || result.status !== 0);
  return {
    requested: targets.length > 0,
    targets: targets.map((entry) => ({
      pid: entry.pid,
      createdAtMs: entry.createdAtMs,
    })),
    results,
    status: firstFailure?.status ?? (results.length > 0 ? 0 : null),
    error: firstFailure?.error ?? null,
  };
}

function stopProcessTree(child) {
  if (!child?.pid) {
    return { requested: false, reason: 'missing_pid' };
  }
  if (child.exitCode !== null) {
    return { requested: false, reason: 'already_exited' };
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    });
    return {
      requested: true,
      method: 'taskkill_tree_force',
      status: result.status,
      signal: result.signal ?? null,
      error: result.error || result.status !== 0
        ? safeFailure(result.error ?? `taskkill exited with status ${result.status}`)
        : null,
    };
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
    return {
      requested: true,
      method: 'process_group_sigkill',
      status: 0,
      signal: 'SIGKILL',
      error: null,
    };
  } catch (groupError) {
    try {
      child.kill('SIGKILL');
      return {
        requested: true,
        method: 'child_sigkill',
        status: 0,
        signal: 'SIGKILL',
        error: null,
      };
    } catch (childError) {
      return {
        requested: true,
        method: 'child_sigkill',
        status: 1,
        signal: 'SIGKILL',
        error: safeFailure(childError ?? groupError),
      };
    }
  }
}

async function runBrowserActionWithTimeout(action, timeoutMs, sleepFn, completedStatus) {
  if (typeof action !== 'function') return { status: 'unavailable' };
  const actionPromise = Promise.resolve().then(action);
  actionPromise.catch(() => {});
  return Promise.race([
    actionPromise.then(
      () => ({ status: completedStatus }),
      (error) => ({ status: 'failed', error: safeFailure(error) }),
    ),
    sleepFn(timeoutMs).then(() => ({ status: 'timed_out', timeoutMs })),
  ]);
}

function normalizeExitCode(code) {
  return Number.isInteger(code) ? code : null;
}

function createMetroExitMonitor(child, now = Date.now) {
  let exitRecord = null;
  let closeRecord = null;
  let resolveExit;
  let resolveClose;
  const exitPromise = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const closePromise = new Promise((resolvePromise) => {
    resolveClose = resolvePromise;
  });

  function recordExit(event, code, signal, error = null) {
    const next = {
      observed: true,
      event,
      code: normalizeExitCode(code),
      signal: signal ?? null,
      error: error ? safeFailure(error) : null,
      observedAt: new Date(now()).toISOString(),
      observedAtMs: now(),
    };
    if (!exitRecord) {
      exitRecord = next;
      resolveExit(next);
      return;
    }
    if (event === 'exit' && exitRecord.event === 'error') {
      exitRecord = {
        ...next,
        error: exitRecord.error,
      };
    }
  }

  child.once('error', (error) => {
    recordExit('error', null, null, error);
  });
  child.once('exit', (code, signal) => {
    recordExit('exit', code, signal);
  });
  child.once('close', (code, signal) => {
    closeRecord = {
      code: normalizeExitCode(code),
      signal: signal ?? null,
      observedAt: new Date(now()).toISOString(),
    };
    if (!exitRecord) recordExit('close', code, signal);
    resolveClose(closeRecord);
  });

  function snapshot() {
    return {
      ...(exitRecord ?? {
        observed: false,
        event: null,
        code: null,
        signal: null,
        error: null,
        observedAt: null,
        observedAtMs: null,
      }),
      close: closeRecord,
    };
  }

  function failureFor(phase) {
    const exit = snapshot();
    const detail = exit.error
      ? exit.error
      : `code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}`;
    const error = new Error(`Metro exited during ${phase} (${detail})`);
    error.name = 'MetroProcessExitError';
    error.phase = phase;
    error.metroExit = exit;
    return error;
  }

  return {
    failureFor,
    snapshot,
    throwIfExited(phase) {
      if (exitRecord) throw failureFor(phase);
    },
    async race(operationPromise, phase) {
      const operation = Promise.resolve(operationPromise);
      if (exitRecord) {
        operation.catch(() => {});
        throw failureFor(phase);
      }
      return Promise.race([
        operation,
        exitPromise.then(() => {
          throw failureFor(phase);
        }),
      ]);
    },
    async waitForClose(timeoutMs, sleepFn = sleep) {
      if (closeRecord) return closeRecord;
      await Promise.race([
        closePromise,
        sleepFn(timeoutMs),
      ]);
      return closeRecord;
    },
  };
}

async function waitForHttpReady(url, monitor, timeoutMs, dependencies, raceRun) {
  const deadline = dependencies.now() + timeoutMs;
  let lastFailure = 'not_started';
  while (dependencies.now() < deadline) {
    monitor.throwIfExited('metro_readiness');
    try {
      const response = await raceRun(monitor.race(
        dependencies.fetch(url, { signal: AbortSignal.timeout(10_000) }),
        'metro_readiness',
      ));
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      if (error?.name === 'MetroProcessExitError') throw error;
      lastFailure = safeFailure(error);
    }
    await raceRun(monitor.race(
      dependencies.sleep(Math.min(2000, Math.max(1, deadline - dependencies.now()))),
      'metro_readiness',
    ));
  }
  throw new Error(`Metro did not become ready: ${lastFailure}`);
}

async function navigateWithRetry(page, url, timeoutMs, monitor, dependencies, raceRun) {
  const deadline = dependencies.now() + timeoutMs;
  let lastFailure = 'not_started';
  while (dependencies.now() < deadline) {
    monitor.throwIfExited('browser_navigation');
    try {
      await raceRun(monitor.race(
        page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(120_000, Math.max(1, deadline - dependencies.now())),
        }),
        'browser_navigation',
      ));
      return;
    } catch (error) {
      if (error?.name === 'MetroProcessExitError') throw error;
      lastFailure = safeFailure(error);
    }
    await raceRun(monitor.race(
      dependencies.sleep(Math.min(2000, Math.max(1, deadline - dependencies.now()))),
      'browser_navigation',
    ));
  }
  throw new Error(`Browser page did not finish the initial Metro bundle: ${lastFailure}`);
}

function stableHandleWindow(samples, durationMs) {
  const withHandles = samples.filter((sample) => Number.isFinite(sample.handleCount));
  if (withHandles.length < 4) return { stable: false, reason: 'insufficient_samples' };
  const warmupMs = Math.min(10 * 60 * 1000, Math.floor(durationMs / 3));
  const stableSamples = withHandles.filter((sample) => sample.elapsedMs >= warmupMs);
  if (stableSamples.length < 3) return { stable: false, reason: 'insufficient_post_warmup_samples' };
  const counts = stableSamples.map((sample) => sample.handleCount);
  const minimum = Math.min(...counts);
  const maximum = Math.max(...counts);
  const first = counts[0];
  const last = counts.at(-1);
  const allowedWindow = Math.max(2000, Math.round(minimum * 0.1));
  return {
    stable: maximum - minimum <= allowedWindow && last - first <= allowedWindow,
    minimum,
    maximum,
    first,
    last,
    allowedWindow,
  };
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  let browserServer;
  try {
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true });
  } catch {
    browserServer = await chromium.launchServer({ headless: true });
  }
  try {
    const browser = await chromium.connect(browserServer.wsEndpoint());
    return {
      browser,
      browserPid: browserServer.process()?.pid ?? null,
      close: () => browserServer.close(),
      kill: () => browserServer.kill(),
    };
  } catch (error) {
    await browserServer.kill().catch(() => {});
    throw error;
  }
}

function resolveRunOptions(overrides = {}, argv = process.argv.slice(2)) {
  const requestedArtifactPath = overrides.artifactPath
    || readArgument('artifact', argv)
    || join(repoRoot, '.project', 'qa', 'metro-windows-hmr-soak-60m.json');
  const requestedLogPath = overrides.logPath
    || readArgument('log-path', argv)
    || join(repoRoot, '.project', 'qa', 'metro-windows-hmr-soak-60m.server.log');
  return {
    durationMs: positiveInteger(
      overrides.durationMs ?? readArgument('duration-ms', argv),
      60 * 60 * 1000,
    ),
    updateIntervalMs: positiveInteger(
      overrides.updateIntervalMs ?? readArgument('update-interval-ms', argv),
      60_000,
    ),
    pagesCount: positiveInteger(overrides.pagesCount ?? readArgument('pages', argv), 6),
    port: positiveInteger(overrides.port ?? readArgument('port', argv), 18_321),
    handleBudget: positiveInteger(
      overrides.handleBudget ?? readArgument('handle-budget', argv),
      30_000,
    ),
    readinessTimeoutMs: positiveInteger(
      overrides.readinessTimeoutMs ?? readArgument('readiness-timeout-ms', argv),
      15 * 60 * 1000,
    ),
    navigationTimeoutMs: positiveInteger(
      overrides.navigationTimeoutMs ?? readArgument('navigation-timeout-ms', argv),
      15 * 60 * 1000,
    ),
    startupTimeoutMs: positiveInteger(
      overrides.startupTimeoutMs ?? readArgument('startup-timeout-ms', argv),
      Math.max(120_000, Math.min(15 * 60 * 1000, positiveInteger(
        overrides.durationMs ?? readArgument('duration-ms', argv),
        60 * 60 * 1000,
      ))),
    ),
    heartbeatIntervalMs: positiveInteger(
      overrides.heartbeatIntervalMs ?? readArgument('heartbeat-interval-ms', argv),
      5_000,
    ),
    markerTimeoutMs: positiveInteger(
      overrides.markerTimeoutMs ?? readArgument('marker-timeout-ms', argv),
      5 * 60 * 1000,
    ),
    browserCloseTimeoutMs: positiveInteger(overrides.browserCloseTimeoutMs, 10_000),
    browserKillTimeoutMs: positiveInteger(overrides.browserKillTimeoutMs, 10_000),
    processCloseTimeoutMs: positiveInteger(overrides.processCloseTimeoutMs, 10_000),
    cleanupSettleMs: positiveInteger(overrides.cleanupSettleMs, 1000),
    artifactPath: resolve(requestedArtifactPath),
    logPath: resolve(requestedLogPath),
  };
}

function defaultSpawnMetro({ command, args, cwd, env }) {
  return spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function describeFailedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false || value?.stable === false)
    .map(([name]) => name)
    .join(', ');
}

function buildFailure({
  primaryFailure,
  failurePhase,
  cleanupFailures,
  metroExit,
  serverOutput,
}) {
  const fallback = cleanupFailures.length > 0
    ? cleanupFailures[0].message
    : 'HMR soak did not complete';
  return {
    phase: primaryFailure?.phase ?? failurePhase ?? cleanupFailures[0]?.phase ?? 'unknown',
    message: safeFailure(primaryFailure ?? fallback),
    metroOutputTail: safeOutputTail(serverOutput),
    enoentBasenames: extractEnoentBasenames(serverOutput),
    cleanupErrors: cleanupFailures,
    metroExitObserved: metroExit.observed,
  };
}

function normalizeTreeSnapshot(snapshot, rootPid) {
  const processes = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  const rootProcess = processes.find((entry) => entry.pid === rootPid);
  return {
    rootPid,
    rootCreatedAtMs: snapshot?.rootCreatedAtMs ?? rootProcess?.createdAtMs ?? null,
    sampledAt: snapshot?.sampledAt ?? new Date().toISOString(),
    processes,
    ...(snapshot?.error ? { error: snapshot.error } : {}),
  };
}

export async function runMetroWindowsHmrSoak({
  options: optionOverrides = {},
  dependencies: dependencyOverrides = {},
} = {}) {
  const options = resolveRunOptions(optionOverrides);
  const dependencies = {
    abortSignal: null,
    captureProcessTree,
    fetch: globalThis.fetch.bind(globalThis),
    launchBrowser,
    now: Date.now,
    sampleProcess: sampleWindowsProcess,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    sleep,
    spawnMetro: defaultSpawnMetro,
    stopProcessTree,
    ...dependencyOverrides,
  };

  const startedAtMs = dependencies.now();
  const serverUrl = `http://127.0.0.1:${options.port}`;
  const artifact = {
    contractVersion: 1,
    operation: 'happier_windows_metro_hmr_wall_clock_soak',
    status: 'running',
    sourceHead: 'unavailable',
    metroConfigSha256: 'unavailable',
    startedAt: new Date(startedAtMs).toISOString(),
    phase: 'initialize',
    lastHeartbeatAt: new Date(startedAtMs).toISOString(),
    soakStartedAt: null,
    finishedAt: null,
    requestedDurationMs: options.durationMs,
    elapsedMs: 0,
    pagesCount: options.pagesCount,
    updateIntervalMs: options.updateIntervalMs,
    handleBudget: options.handleBudget,
    port: options.port,
    serverLogPath: options.logPath,
    metroPid: null,
    metroExit: {
      observed: false,
      event: null,
      code: null,
      signal: null,
      error: null,
      observedAt: null,
      observedAtMs: null,
      close: null,
    },
    processTree: {
      beforeCleanup: null,
      cleanup: null,
      afterCleanup: null,
      trackedPids: [],
      remainingPids: [],
      exited: false,
    },
    updates: [],
    processSamples: [],
    browser: { pageErrors: 0, consoleErrors: 0, diagnostics: [] },
    browserCleanup: null,
    assertions: null,
    failure: null,
  };

  let isolatedRoot = null;
  let markerRoot = null;
  let markerPath = null;
  let soakStartedAtMs = null;
  let serverOutput = '';
  let browser = null;
  let browserRuntime = null;
  let metro = null;
  let metroMonitor = null;
  let stopReason = null;
  let currentPhase = 'initialize';
  let primaryFailure = null;
  let failurePhase = null;
  let completedSuccessfully = false;
  const cleanupFailures = [];

  let abortError = null;
  let rejectRunAbort = null;
  const runAbortPromise = new Promise((_, reject) => {
    rejectRunAbort = reject;
  });
  const requestAbort = (reason) => {
    if (!stopReason) stopReason = reason;
    if (abortError) return;
    abortError = new Error(`HMR soak interrupted by ${reason}`);
    abortError.name = 'HmrSoakAbortError';
    abortError.phase = currentPhase;
    rejectRunAbort?.(abortError);
  };
  const raceRun = (operation) => Promise.race([operation, runAbortPromise]);
  const externalAbortSignal = dependencies.abortSignal;
  const externalAbortHandler = () => requestAbort('external_abort');
  if (externalAbortSignal?.aborted) externalAbortHandler();
  else externalAbortSignal?.addEventListener?.('abort', externalAbortHandler, { once: true });
  const startupTimeoutHandle = setTimeout(
    () => requestAbort('startup_timeout'),
    options.startupTimeoutMs,
  );
  let heartbeatHandle = null;

  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      requestAbort(signal);
    };
    process.once(signal, handler);
    signalHandlers.set(signal, handler);
  }

  try {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await mkdir(dirname(options.logPath), { recursive: true });
    await writeJsonAtomic(options.artifactPath, artifact);
    heartbeatHandle = dependencies.setInterval(() => {
      artifact.phase = currentPhase;
      artifact.lastHeartbeatAt = new Date(dependencies.now()).toISOString();
      void writeJsonAtomic(options.artifactPath, artifact).catch(() => {});
    }, options.heartbeatIntervalMs);

    currentPhase = 'capture_source';
    artifact.metroConfigSha256 = createHash('sha256')
      .update(await readFile(metroConfigPath))
      .digest('hex');
    artifact.sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    }).stdout?.trim() || 'unavailable';

    currentPhase = 'prepare_isolated_root';
    isolatedRoot = await mkdtemp(join(tmpdir(), 'happier-metro-hmr-soak-'));
    // Keep the mutation target under Metro's existing UI project root. Windows
    // Metro can retain a stale external watch-root entry across cold rebuilds,
    // which makes an otherwise present temporary marker appear as ENOENT.
    markerRoot = join(uiDir, 'sources', 'dev', `.happier-hmr-soak-${process.pid}`);
    markerPath = join(markerRoot, 'hmrSoakMarker.ts');
    await mkdir(markerRoot, { recursive: true });
    await mkdir(join(isolatedRoot, 'tmp'), { recursive: true });
    await writeFile(markerPath, markerSource('initial'), 'utf8');
    await writeJsonAtomic(options.artifactPath, artifact);

    currentPhase = 'spawn_metro';
    const metroEnv = {
      ...process.env,
      EXPO_NO_INTERACTIVE: '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_HAPPIER_HMR_SOAK: '1',
      HAPPIER_UI_HMR_SOAK_ROOT: markerRoot,
      HAPPIER_UI_METRO_DISABLE_WATCHMAN: '1',
      HAPPIER_UI_METRO_MODE: 'development',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
      TEMP: join(isolatedRoot, 'tmp'),
      TMP: join(isolatedRoot, 'tmp'),
      TMPDIR: join(isolatedRoot, 'tmp'),
    };
    delete metroEnv.CI;
    metro = dependencies.spawnMetro({
      command: process.execPath,
      args: [expoCliPath, 'start', '--web', '--port', String(options.port), '--clear'],
      cwd: uiDir,
      env: metroEnv,
    });
    metroMonitor = createMetroExitMonitor(metro, dependencies.now);
    artifact.metroPid = metro.pid ?? null;
    metro.stdout?.on('data', (chunk) => {
      serverOutput = boundedAppend(serverOutput, chunk);
    });
    metro.stderr?.on('data', (chunk) => {
      serverOutput = boundedAppend(serverOutput, chunk);
    });
    await writeJsonAtomic(options.artifactPath, artifact);

    currentPhase = 'metro_readiness';
    await waitForHttpReady(
      serverUrl,
      metroMonitor,
      options.readinessTimeoutMs,
      dependencies,
      raceRun,
    );

    currentPhase = 'browser_launch';
    const launchedBrowser = await raceRun(metroMonitor.race(
      dependencies.launchBrowser(),
      'browser_launch',
    ));
    browserRuntime = launchedBrowser?.browser
      ? {
          browser: launchedBrowser.browser,
          browserPid: launchedBrowser.browserPid ?? null,
          close: launchedBrowser.close ?? (() => launchedBrowser.browser.close()),
          kill: launchedBrowser.kill ?? null,
        }
      : {
          browser: launchedBrowser,
          browserPid: null,
          close: () => launchedBrowser.close(),
          kill: null,
        };
    browser = browserRuntime.browser;

    const pages = [];
    for (let index = 0; index < options.pagesCount; index += 1) {
      currentPhase = 'browser_navigation';
      const page = await raceRun(metroMonitor.race(browser.newPage(), 'browser_navigation'));
      const recordBrowserDiagnostic = (kind, value) => {
        if (artifact.browser.diagnostics.length >= 20) return;
        artifact.browser.diagnostics.push({
          phase: currentPhase,
          kind,
          message: safeFailure(value).slice(0, 1000),
        });
      };
      page.on('pageerror', (error) => {
        artifact.browser.pageErrors += 1;
        recordBrowserDiagnostic('pageerror', error);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          artifact.browser.consoleErrors += 1;
          recordBrowserDiagnostic('console_error', message.text());
        }
      });
      page.on('requestfailed', (request) => {
        recordBrowserDiagnostic('request_failed', `${request.url()} ${request.failure()?.errorText ?? ''}`);
      });
      await navigateWithRetry(
        page,
        `${serverUrl}/?hmr-soak-page=${index}`,
        options.navigationTimeoutMs,
        metroMonitor,
        dependencies,
        raceRun,
      );
      currentPhase = 'initial_marker';
      await raceRun(metroMonitor.race(
        page.waitForFunction(
          () => window.__HAPPIER_HMR_SOAK_MARKER__ === 'initial',
          undefined,
          { timeout: options.markerTimeoutMs },
        ),
        'initial_marker',
      ));
      pages.push(page);
    }

    soakStartedAtMs = dependencies.now();
    clearTimeout(startupTimeoutHandle);
    artifact.soakStartedAt = new Date(soakStartedAtMs).toISOString();
    await writeJsonAtomic(options.artifactPath, artifact);
    let updateIndex = 0;
    while (dependencies.now() - soakStartedAtMs < options.durationMs && !stopReason) {
      currentPhase = 'hmr_update';
      metroMonitor.throwIfExited('hmr_update');
      const elapsedMs = dependencies.now() - soakStartedAtMs;
      const processSample = dependencies.sampleProcess(metro.pid);
      if (processSample) {
        artifact.processSamples.push({ elapsedMs, ...processSample });
      }

      updateIndex += 1;
      const marker = `update-${String(updateIndex).padStart(4, '0')}`;
      const updateStartedAtMs = dependencies.now();
      await writeFile(markerPath, markerSource(marker), 'utf8');
      const observations = await raceRun(metroMonitor.race(
        Promise.all(pages.map(async (page, pageIndex) => {
          try {
            await page.waitForFunction(
              (expected) => window.__HAPPIER_HMR_SOAK_MARKER__ === expected,
              marker,
              { timeout: Math.max(30_000, Math.min(options.updateIntervalMs, 120_000)) },
            );
            return { pageIndex, observed: true };
          } catch {
            return { pageIndex, observed: false };
          }
        })),
        'hmr_update',
      ));
      artifact.updates.push({
        update: updateIndex,
        elapsedMs,
        latencyMs: dependencies.now() - updateStartedAtMs,
        observedPages: observations.filter((value) => value.observed).length,
        failedPages: observations.filter((value) => !value.observed).map((value) => value.pageIndex),
      });
      artifact.elapsedMs = dependencies.now() - soakStartedAtMs;
      await writeJsonAtomic(options.artifactPath, artifact);
      await raceRun(metroMonitor.race(
        dependencies.sleep(Math.min(
          options.updateIntervalMs,
          Math.max(1, options.durationMs - (dependencies.now() - soakStartedAtMs)),
        )),
        'hmr_update',
      ));
    }

    currentPhase = 'evaluate_assertions';
    const finishedAtMs = dependencies.now();
    metroMonitor.throwIfExited('evaluate_assertions');
    const finalSample = dependencies.sampleProcess(metro.pid);
    if (finalSample) {
      artifact.processSamples.push({ elapsedMs: finishedAtMs - soakStartedAtMs, ...finalSample });
    }
    const handleWindow = stableHandleWindow(artifact.processSamples, options.durationMs);
    const maximumHandles = Math.max(
      0,
      ...artifact.processSamples.map((sample) => Number(sample.handleCount) || 0),
    );
    const allUpdatesObserved = (
      artifact.updates.length > 0
      && artifact.updates.every((update) => update.observedPages === options.pagesCount)
    );
    const noEmfile = !/EMFILE|too many open files/iu.test(serverOutput);
    const wallClockSatisfied = finishedAtMs - soakStartedAtMs >= options.durationMs;
    const withinHandleBudget = maximumHandles <= options.handleBudget;
    artifact.assertions = {
      wallClockSatisfied,
      allUpdatesObserved,
      noEmfile,
      withinHandleBudget,
      maximumHandles,
      handleWindow,
    };
    completedSuccessfully = (
      !stopReason
      && wallClockSatisfied
      && allUpdatesObserved
      && noEmfile
      && withinHandleBudget
      && handleWindow.stable
    );
    if (!completedSuccessfully) {
      const failedAssertions = describeFailedAssertions(artifact.assertions);
      throw new Error(
        stopReason
          ? `HMR soak interrupted by ${stopReason}`
          : `HMR soak assertions failed: ${failedAssertions || 'unknown'}`,
      );
    }
  } catch (error) {
    primaryFailure = error;
    failurePhase = error?.phase ?? currentPhase;
  } finally {
    clearTimeout(startupTimeoutHandle);
    if (heartbeatHandle) dependencies.clearInterval(heartbeatHandle);
    externalAbortSignal?.removeEventListener?.('abort', externalAbortHandler);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();

    const browserPid = browserRuntime?.browserPid ?? null;
    currentPhase = 'browser_process_tree_before_cleanup';
    let browserTreeBeforeCleanup;
    try {
      browserTreeBeforeCleanup = browserPid
        ? normalizeTreeSnapshot(
            dependencies.captureProcessTree(browserPid),
            browserPid,
          )
        : normalizeTreeSnapshot({ processes: [] }, browserPid);
    } catch (error) {
      browserTreeBeforeCleanup = normalizeTreeSnapshot(
        { error: safeFailure(error), processes: [] },
        browserPid,
      );
    }

    currentPhase = 'browser_cleanup';
    const browserClose = browserRuntime
      ? await runBrowserActionWithTimeout(
          browserRuntime.close,
          options.browserCloseTimeoutMs,
          dependencies.sleep,
          'closed',
        )
      : { status: 'not_started' };
    let browserKill = { status: 'not_needed' };
    let fallbackStop = null;

    currentPhase = 'browser_process_tree_after_close';
    let browserTreeAfterClose;
    try {
      browserTreeAfterClose = browserPid
        ? normalizeTreeSnapshot(
            dependencies.captureProcessTree(
              browserPid,
              browserTreeBeforeCleanup.rootCreatedAtMs,
              browserTreeBeforeCleanup.processes,
            ),
            browserPid,
          )
        : normalizeTreeSnapshot({ processes: [] }, browserPid);
    } catch (error) {
      browserTreeAfterClose = normalizeTreeSnapshot(
        { error: safeFailure(error), processes: [] },
        browserPid,
      );
    }

    if (
      browserPid
      && !browserTreeAfterClose.error
      && browserTreeAfterClose.processes.length > 0
    ) {
      currentPhase = 'browser_process_tree_force_cleanup';
      fallbackStop = stopCapturedProcessTrees(
        browserTreeAfterClose,
        dependencies.stopProcessTree,
      );
      await dependencies.sleep(options.cleanupSettleMs);
    }

    currentPhase = 'browser_process_tree_after_force_cleanup';
    let browserTreeAfterForceCleanup = browserTreeAfterClose;
    if (fallbackStop) {
      try {
        browserTreeAfterForceCleanup = normalizeTreeSnapshot(
          dependencies.captureProcessTree(
            browserPid,
            browserTreeBeforeCleanup.rootCreatedAtMs,
            browserTreeBeforeCleanup.processes,
          ),
          browserPid,
        );
      } catch (error) {
        browserTreeAfterForceCleanup = normalizeTreeSnapshot(
          { error: safeFailure(error), processes: [] },
          browserPid,
        );
      }
    }

    const browserCloseNeedsFallback = (
      browserClose.status === 'failed'
      || browserClose.status === 'timed_out'
    );
    const browserTreeStillLive = (
      browserPid
      && (
        browserTreeAfterForceCleanup.error
        || browserTreeAfterForceCleanup.processes.length > 0
      )
    );
    if (
      browserCloseNeedsFallback
      && (!browserPid || browserTreeStillLive)
    ) {
      browserKill = await runBrowserActionWithTimeout(
        browserRuntime?.kill,
        options.browserKillTimeoutMs,
        dependencies.sleep,
        'killed',
      );
      await dependencies.sleep(options.cleanupSettleMs);
    }

    currentPhase = 'browser_process_tree_after_cleanup';
    let browserTreeAfterCleanup = browserTreeAfterForceCleanup;
    if (browserKill.status !== 'not_needed' && browserPid) {
      try {
        browserTreeAfterCleanup = normalizeTreeSnapshot(
          dependencies.captureProcessTree(
            browserPid,
            browserTreeBeforeCleanup.rootCreatedAtMs,
            browserTreeBeforeCleanup.processes,
          ),
          browserPid,
        );
      } catch (error) {
        browserTreeAfterCleanup = normalizeTreeSnapshot(
          { error: safeFailure(error), processes: [] },
          browserPid,
        );
      }
    }

    const browserActionConfirmedExit = (
      browserClose.status === 'closed'
      || browserKill.status === 'killed'
    );
    const browserProcessTreeExited = browserPid
      ? (
          browserTreeAfterCleanup.error
            ? browserActionConfirmedExit
            : browserTreeAfterCleanup.processes.length === 0
        )
      : (!browserRuntime || browserActionConfirmedExit);
    if (!browserProcessTreeExited) {
      cleanupFailures.push({
        phase: 'browser_cleanup',
        message: browserClose.status === 'timed_out'
          ? `Browser close timed out after ${browserClose.timeoutMs}ms and its process is still live`
          : browserClose.error || 'Browser process did not exit during cleanup',
      });
    }
    artifact.browserCleanup = {
      browserPid,
      close: browserClose,
      kill: browserKill,
      fallbackStop,
      processTree: {
        beforeCleanup: browserTreeBeforeCleanup,
        afterClose: browserTreeAfterClose,
        afterForceCleanup: browserTreeAfterForceCleanup,
        afterCleanup: browserTreeAfterCleanup,
        exited: browserProcessTreeExited,
      },
    };

    const metroPid = metro?.pid ?? null;
    const exitBeforeCleanup = metroMonitor?.snapshot() ?? artifact.metroExit;
    if (exitBeforeCleanup.observed && !primaryFailure) {
      primaryFailure = metroMonitor.failureFor('pre_cleanup');
      failurePhase = 'pre_cleanup';
    }

    currentPhase = 'process_tree_before_cleanup';
    let beforeCleanup;
    try {
      beforeCleanup = normalizeTreeSnapshot(
        dependencies.captureProcessTree(metroPid),
        metroPid,
      );
    } catch (error) {
      beforeCleanup = normalizeTreeSnapshot(
        { error: safeFailure(error), processes: [] },
        metroPid,
      );
      cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
    }

    currentPhase = 'process_tree_cleanup';
    let cleanupResult;
    try {
      cleanupResult = dependencies.stopProcessTree(metro);
    } catch (error) {
      cleanupResult = {
        requested: true,
        reason: 'cleanup_threw',
        error: safeFailure(error),
      };
      cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
    }
    await metroMonitor
      ?.waitForClose(options.processCloseTimeoutMs, dependencies.sleep)
      .catch((error) => {
        cleanupFailures.push({ phase: 'wait_for_metro_close', message: safeFailure(error) });
      });
    await dependencies.sleep(options.cleanupSettleMs);

    currentPhase = 'process_tree_after_cleanup';
    let afterCleanup;
    try {
      afterCleanup = normalizeTreeSnapshot(
        dependencies.captureProcessTree(
          metroPid,
          beforeCleanup.rootCreatedAtMs,
          beforeCleanup.processes,
        ),
        metroPid,
      );
    } catch (error) {
      afterCleanup = normalizeTreeSnapshot(
        { error: safeFailure(error), processes: [] },
        metroPid,
      );
      cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
    }

    const trackedPids = [...new Set([
      ...(metroPid ? [metroPid] : []),
      ...beforeCleanup.processes.map((entry) => entry.pid),
    ])];
    const remainingPids = afterCleanup.processes.map((entry) => entry.pid);
    const processTreeExited = remainingPids.length === 0;
    artifact.processTree = {
      beforeCleanup,
      cleanup: cleanupResult,
      afterCleanup,
      trackedPids,
      remainingPids,
      exited: processTreeExited,
    };
    artifact.processTreeExited = processTreeExited;
    artifact.metroExit = metroMonitor?.snapshot() ?? artifact.metroExit;

    currentPhase = 'write_server_log';
    try {
      await mkdir(dirname(options.logPath), { recursive: true });
      await writeFile(options.logPath, sanitizeRuntimeLogText(serverOutput), 'utf8');
    } catch (error) {
      cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
    }

    currentPhase = 'remove_isolated_root';
    if (isolatedRoot) {
      try {
        await rm(isolatedRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
      }
    }

    currentPhase = 'remove_marker_root';
    if (markerRoot) {
      try {
        await rm(markerRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push({ phase: currentPhase, message: safeFailure(error) });
      }
    }

    if (!processTreeExited && !primaryFailure) {
      primaryFailure = new Error(
        `Metro process tree still has live PIDs: ${remainingPids.join(', ') || 'unknown'}`,
      );
      failurePhase = 'process_tree_after_cleanup';
    }
    if (cleanupFailures.length > 0 && !primaryFailure) {
      primaryFailure = new Error(cleanupFailures[0].message);
      failurePhase = cleanupFailures[0].phase;
    }
    if (stopReason && !primaryFailure) {
      primaryFailure = new Error(`HMR soak interrupted by ${stopReason}`);
      failurePhase = 'signal';
    }

    const finishedAtMs = dependencies.now();
    const terminalSucceeded = (
      completedSuccessfully
      && !primaryFailure
      && cleanupFailures.length === 0
      && processTreeExited
      && !stopReason
    );
    artifact.status = terminalSucceeded ? 'complete' : 'failed';
    artifact.phase = 'write_terminal_artifact';
    artifact.lastHeartbeatAt = new Date(finishedAtMs).toISOString();
    artifact.finishedAt = new Date(finishedAtMs).toISOString();
    artifact.elapsedMs = soakStartedAtMs ? finishedAtMs - soakStartedAtMs : 0;
    artifact.operationElapsedMs = finishedAtMs - startedAtMs;
    artifact.stopReason = stopReason;
    artifact.assertions = {
      ...(artifact.assertions ?? {}),
      noEmfile: !/EMFILE|too many open files/iu.test(serverOutput),
      processTreeExited,
    };
    artifact.failure = terminalSucceeded
      ? null
      : buildFailure({
          primaryFailure,
          failurePhase,
          cleanupFailures,
          metroExit: artifact.metroExit,
          serverOutput,
        });

    currentPhase = 'write_terminal_artifact';
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeJsonAtomic(options.artifactPath, artifact);
  }

  return artifact;
}

async function main() {
  const artifact = await runMetroWindowsHmrSoak();
  await new Promise((resolvePromise, rejectPromise) => {
    process.stdout.write(
      `${JSON.stringify({
        artifactPath: resolve(readArgument('artifact')
          || join(repoRoot, '.project', 'qa', 'metro-windows-hmr-soak-60m.json')),
        serverLogPath: artifact.serverLogPath,
        status: artifact.status,
        elapsedMs: artifact.elapsedMs,
        updates: artifact.updates.length,
        processTreeExited: artifact.processTree.exited,
        metroExit: artifact.metroExit,
      })}\n`,
      (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      },
    );
  });
  process.exit(artifact.status === 'complete' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    await new Promise((resolvePromise) => {
      process.stderr.write(`[metro-hmr-soak] ${safeFailure(error)}\n`, resolvePromise);
    });
    process.exit(1);
  });
}
