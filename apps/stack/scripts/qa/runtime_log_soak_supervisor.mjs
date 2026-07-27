import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPidAlive } from '../utils/proc/pids.mjs';
import { createRuntimeLogSink } from '../utils/proc/rotating_log_sink.mjs';

const qaDir = dirname(fileURLToPath(import.meta.url));
const workloadPath = join(qaDir, 'runtime_log_soak.mjs');
const artifactDir = join(qaDir, 'artifacts');
const CRASH_EVIDENCE_MAX_BYTES = 8 * 1024;
const CRASH_EVIDENCE_MAX_LINES = 40;

function readArgument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function finishWritable(stream) {
  await new Promise((resolvePromise, rejectPromise) => {
    stream.once('error', rejectPromise);
    stream.end(resolvePromise);
  });
}

async function writeWithBackpressure(stream, value) {
  if (stream.write(value)) return;
  await new Promise((resolvePromise, rejectPromise) => {
    stream.once('drain', resolvePromise);
    stream.once('error', rejectPromise);
  });
}

async function readCrashEvidence(logPath) {
  const logDir = dirname(logPath);
  const logBase = basename(logPath);
  let entries = [];
  try {
    entries = (await readdir(logDir))
      .filter((name) => name === logBase || name.startsWith(`${logBase}.`))
      .sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let text = '';
  let totalBytes = 0;
  for (const name of entries) {
    const path = join(logDir, name);
    const metadata = await stat(path);
    totalBytes += metadata.size;
    text += await readFile(path, 'utf8');
  }
  const tail = Buffer.from(text).subarray(Math.max(0, Buffer.byteLength(text) - CRASH_EVIDENCE_MAX_BYTES)).toString('utf8');
  return {
    files: entries,
    totalBytes,
    truncated: totalBytes > CRASH_EVIDENCE_MAX_BYTES,
    lines: tail.split(/\r?\n/u).filter(Boolean).slice(-CRASH_EVIDENCE_MAX_LINES),
  };
}

function resolveConfig() {
  const durationMs = positiveInteger(readArgument('duration-ms'), 24 * 60 * 60 * 1000);
  const intervalMs = positiveInteger(readArgument('interval-ms'), 1000);
  const maxBytes = positiveInteger(readArgument('max-bytes'), 1024 * 1024);
  const maxAgeMs = positiveInteger(readArgument('max-age-ms'), 60 * 60 * 1000);
  const maxFiles = positiveInteger(readArgument('max-files'), 8);
  const logPath = resolve(readArgument('log-path') || join(artifactDir, 'runtime-log-soak.log'));
  const artifactPath = resolve(readArgument('artifact') || join(artifactDir, 'runtime-log-soak-24h.supervisor.json'));
  const childArtifactPath = resolve(readArgument('child-artifact') || join(artifactDir, 'runtime-log-soak-24h.child.json'));
  const supervisorLogPath = resolve(readArgument('supervisor-log-path') || join(artifactDir, 'runtime-log-soak-supervisor.log'));
  const testCrashAfterWrites = positiveInteger(readArgument('test-crash-after-writes'), 0);
  return {
    durationMs,
    intervalMs,
    maxBytes,
    maxAgeMs,
    maxFiles,
    logPath,
    artifactPath,
    childArtifactPath,
    supervisorLogPath,
    testCrashAfterWrites,
  };
}

function childArgs(config) {
  const args = [
    workloadPath,
    `--duration-ms=${config.durationMs}`,
    `--interval-ms=${config.intervalMs}`,
    `--max-bytes=${config.maxBytes}`,
    `--max-age-ms=${config.maxAgeMs}`,
    `--max-files=${config.maxFiles}`,
    `--log-path=${config.logPath}`,
    `--artifact=${config.childArtifactPath}`,
  ];
  if (config.testCrashAfterWrites > 0) {
    args.push(`--test-crash-after-writes=${config.testCrashAfterWrites}`);
  }
  return args;
}

function waitForChildExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
}

async function ensureNoLiveSupervisor(config) {
  const existing = await readJson(config.artifactPath);
  if (existing?.status === 'running' && isPidAlive(existing.supervisorPid)) {
    throw new Error(`runtime-log soak already supervised by pid ${existing.supervisorPid}`);
  }
}

async function supervise(config) {
  const startedAtMs = Date.now();
  const artifact = {
    contractVersion: 2,
    operation: 'happier_runtime_log_soak_supervisor',
    status: 'running',
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    supervisorPid: process.pid,
    childArtifactPath: config.childArtifactPath,
    supervisorLogPath: config.supervisorLogPath,
    durationMs: config.durationMs,
    intervalMs: config.intervalMs,
    policy: { maxBytes: config.maxBytes, maxAgeMs: config.maxAgeMs, maxFiles: config.maxFiles },
    lastHeartbeatAt: new Date(startedAtMs).toISOString(),
    child: { pid: null, exitCode: null, signal: null, status: null },
    crashEvidence: null,
  };
  await writeJsonAtomic(config.artifactPath, artifact);

  const sink = createRuntimeLogSink(config.supervisorLogPath, {
    ...process.env,
    HAPPIER_STACK_LOG_MAX_BYTES: String(Math.max(config.maxBytes, CRASH_EVIDENCE_MAX_BYTES)),
    HAPPIER_STACK_LOG_MAX_AGE_MS: String(config.maxAgeMs),
    HAPPIER_STACK_LOG_MAX_FILES: String(Math.min(config.maxFiles, 2)),
  });
  let requestedSignal = null;
  let child = null;
  let heartbeat = null;
  const requestStop = (signal) => {
    requestedSignal ??= signal;
    if (child && !child.killed) child.kill('SIGTERM');
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  try {
    child = spawn(process.execPath, childArgs(config), {
      cwd: resolve(qaDir, '..', '..', '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    artifact.child.pid = child.pid ?? null;
    await writeJsonAtomic(config.artifactPath, artifact);
    child.stdout.on('data', (chunk) => {
      void writeWithBackpressure(sink, `[child:stdout] ${String(chunk)}`);
    });
    child.stderr.on('data', (chunk) => {
      void writeWithBackpressure(sink, `[child:stderr] ${String(chunk)}`);
    });
    heartbeat = setInterval(() => {
      artifact.lastHeartbeatAt = new Date().toISOString();
      void writeJsonAtomic(config.artifactPath, artifact).catch(() => {});
    }, 15 * 1000);

    const exit = await waitForChildExit(child);
    const childArtifact = await readJson(config.childArtifactPath);
    artifact.child = {
      pid: child.pid ?? null,
      exitCode: exit.exitCode,
      signal: exit.signal,
      status: childArtifact?.status ?? null,
    };
    if (requestedSignal) {
      artifact.status = 'interrupted';
    } else if (exit.exitCode === 0 && childArtifact?.status === 'passed') {
      artifact.status = 'passed';
    } else if (childArtifact?.finishedAt) {
      artifact.status = 'child_failed';
    } else {
      artifact.status = 'child_crashed';
    }
    artifact.finishedAt = new Date().toISOString();
    artifact.lastHeartbeatAt = artifact.finishedAt;
    artifact.crashEvidence = artifact.status === 'passed' ? null : await readCrashEvidence(config.supervisorLogPath);
    await finishWritable(sink);
    await writeJsonAtomic(config.artifactPath, artifact);
    process.stdout.write(`${JSON.stringify({ artifactPath: config.artifactPath, status: artifact.status, supervisorPid: process.pid, childPid: artifact.child.pid })}\n`);
    return artifact.status === 'passed' ? 0 : 1;
  } catch (error) {
    artifact.status = 'supervisor_failed';
    artifact.finishedAt = new Date().toISOString();
    artifact.lastHeartbeatAt = artifact.finishedAt;
    artifact.failure = error instanceof Error ? error.message : String(error);
    try {
      artifact.crashEvidence = await readCrashEvidence(config.supervisorLogPath);
      await finishWritable(sink);
    } finally {
      await writeJsonAtomic(config.artifactPath, artifact);
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function startDetached(config) {
  await ensureNoLiveSupervisor(config);
  await mkdir(dirname(config.supervisorLogPath), { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', ...process.argv.slice(2).filter((arg) => arg !== '--start')], {
    cwd: resolve(qaDir, '..', '..', '..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({ artifactPath: config.artifactPath, childArtifactPath: config.childArtifactPath, supervisorPid: child.pid })}\n`);
}

if (hasFlag('start') === hasFlag('supervise')) {
  process.stderr.write('use exactly one of --start or --supervise\n');
  process.exitCode = 2;
} else {
  const config = resolveConfig();
  if (hasFlag('start')) {
    await startDetached(config);
  } else {
    process.exitCode = await supervise(config);
  }
}
