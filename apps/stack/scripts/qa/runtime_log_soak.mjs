import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeLogSink } from '../utils/proc/rotating_log_sink.mjs';

const stackDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(stackDir, '..', '..');
const sinkImplementationPath = resolve(
  stackDir,
  'scripts',
  'utils',
  'proc',
  'rotating_log_sink.mjs',
);

function readArgument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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

function gitStatusLogEntries() {
  const result = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return String(result.stdout ?? '')
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => /(?:^|[\\/])happier-[^\\/]*\.(?:log|err\.log|out\.log)$/iu.test(line));
}

async function readRetainedLogs(logPath) {
  const logDir = dirname(logPath);
  const logBase = basename(logPath);
  const names = (await readdir(logDir))
    .filter((name) => name === logBase || name.startsWith(`${logBase}.`))
    .sort();
  let totalBytes = 0;
  let combined = '';
  for (const name of names) {
    const path = join(logDir, name);
    totalBytes += (await stat(path)).size;
    combined += await readFile(path, 'utf8');
  }
  return { names, totalBytes, combined };
}

const durationMs = positiveInteger(readArgument('duration-ms'), 24 * 60 * 60 * 1000);
const intervalMs = positiveInteger(readArgument('interval-ms'), 1000);
const maxBytes = positiveInteger(readArgument('max-bytes'), 1024 * 1024);
const maxAgeMs = positiveInteger(readArgument('max-age-ms'), 60 * 60 * 1000);
const maxFiles = positiveInteger(readArgument('max-files'), 8);
const logPath = resolve(
  readArgument('log-path') || join(stackDir, 'scripts', 'qa', 'artifacts', 'runtime-log-soak.log'),
);
const artifactPath = resolve(
  readArgument('artifact') || join(stackDir, 'scripts', 'qa', 'artifacts', 'runtime-log-soak-24h.child.json'),
);
const testCrashAfterWrites = positiveInteger(readArgument('test-crash-after-writes'), 0);
const sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
}).stdout?.trim() || 'unavailable';
const sinkImplementationSha256 = createHash('sha256')
  .update(await readFile(sinkImplementationPath))
  .digest('hex');
const startedAtMs = Date.now();
let stopReason = null;
let writes = 0;
let lastCheckpointAtMs = 0;

process.once('SIGINT', () => {
  stopReason = 'SIGINT';
});
process.once('SIGTERM', () => {
  stopReason = 'SIGTERM';
});

const artifact = {
  contractVersion: 1,
  operation: 'happier_runtime_log_wall_clock_soak',
  status: 'running',
  sourceHead,
  sinkImplementationSha256,
  startedAt: new Date(startedAtMs).toISOString(),
  finishedAt: null,
  durationMs,
  elapsedMs: 0,
  intervalMs,
  policy: { maxBytes, maxAgeMs, maxFiles },
  writes: 0,
  assertions: null,
};

await mkdir(dirname(artifactPath), { recursive: true });
await writeJsonAtomic(artifactPath, artifact);
const sink = createRuntimeLogSink(logPath, {
  ...process.env,
  HAPPIER_STACK_LOG_MAX_BYTES: String(maxBytes),
  HAPPIER_STACK_LOG_MAX_AGE_MS: String(maxAgeMs),
  HAPPIER_STACK_LOG_MAX_FILES: String(maxFiles),
});

try {
  while (Date.now() - startedAtMs < durationMs && !stopReason) {
    const nowMs = Date.now();
    await writeWithBackpressure(
      sink,
      [
        `at=${new Date(nowMs).toISOString()}`,
        'Authorization: Bearer soak-bearer-secret',
        'Cookie: session=soak-cookie-secret; preference=soak-cookie-preference',
        'refreshToken=soak-refresh-secret',
        'sessionId=soak-session-stable',
        'socketId=soak-socket-stable',
        'remoteAddress=192.168.50.25',
        'workspace="C:\\Users\\datoo\\private-soak-workspace"',
        `payload=${'0123456789abcdef'.repeat(240)}`,
      ].join(' ') + '\n',
    );
    writes += 1;
    if (testCrashAfterWrites > 0 && writes >= testCrashAfterWrites) {
      process.exit(97);
    }
    const elapsedMs = nowMs - startedAtMs;
    if (elapsedMs - lastCheckpointAtMs >= 5 * 60 * 1000) {
      artifact.elapsedMs = elapsedMs;
      artifact.writes = writes;
      await writeJsonAtomic(artifactPath, artifact);
      lastCheckpointAtMs = elapsedMs;
    }
    await sleep(Math.min(intervalMs, Math.max(1, durationMs - (Date.now() - startedAtMs))));
  }
  await finishWritable(sink);

  const finishedAtMs = Date.now();
  const retained = await readRetainedLogs(logPath);
  const forbiddenValues = [
    'soak-bearer-secret',
    'soak-cookie-secret',
    'soak-cookie-preference',
    'soak-refresh-secret',
    'soak-session-stable',
    'soak-socket-stable',
    '192.168.50.25',
    'C:\\Users\\datoo\\private-soak-workspace',
  ];
  const leakedValues = forbiddenValues.filter((value) => retained.combined.includes(value));
  const rootStatusLogEntries = gitStatusLogEntries();
  const wallClockSatisfied = finishedAtMs - startedAtMs >= durationMs;
  const boundedFiles = retained.names.length <= maxFiles;
  const boundedBytes = retained.totalBytes <= maxFiles * (maxBytes + 8192);
  const passed = (
    !stopReason
    && wallClockSatisfied
    && boundedFiles
    && boundedBytes
    && leakedValues.length === 0
    && rootStatusLogEntries.length === 0
  );

  Object.assign(artifact, {
    status: passed ? 'passed' : (stopReason ? 'interrupted' : 'failed'),
    finishedAt: new Date(finishedAtMs).toISOString(),
    elapsedMs: finishedAtMs - startedAtMs,
    writes,
    retained: {
      fileCount: retained.names.length,
      totalBytes: retained.totalBytes,
      names: retained.names,
    },
    assertions: {
      wallClockSatisfied,
      boundedFiles,
      boundedBytes,
      leakedValues,
      rootStatusLogEntries,
    },
    stopReason,
  });
  await writeJsonAtomic(artifactPath, artifact);
  process.stdout.write(`${JSON.stringify({
    artifactPath,
    status: artifact.status,
    elapsedMs: artifact.elapsedMs,
    writes,
  })}\n`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  await finishWritable(sink).catch(() => {});
  Object.assign(artifact, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    writes,
    failure: error instanceof Error ? error.message : String(error),
  });
  await writeJsonAtomic(artifactPath, artifact);
  throw error;
}
