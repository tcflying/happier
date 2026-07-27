import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(uiDir, '..', '..');
const expoCliPath = resolve(repoRoot, 'node_modules', 'expo', 'bin', 'cli');
const metroConfigPath = resolve(uiDir, 'metro.config.js');
const noblePatchPath = resolve(uiDir, 'patches', '@noble+hashes+1.8.0.patch');

function readArgument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function artifactTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function boundedAppend(existing, chunk, maxCharacters = 256_000) {
  const combined = `${existing}${String(chunk ?? '')}`;
  return combined.length <= maxCharacters ? combined : combined.slice(-maxCharacters);
}

function runExpoExport({ outputDir, isolatedRoot }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const isolatedTemp = join(isolatedRoot, 'tmp');
    const args = [
      expoCliPath,
      'export',
      '--platform',
      'web',
      '--output-dir',
      outputDir,
      '-c',
    ];
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: uiDir,
      env: {
        ...process.env,
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
        EXPO_HOME: join(isolatedRoot, 'expo-home'),
        HAPPIER_UI_METRO_MODE: 'build',
        HAPPIER_UI_METRO_RESOLUTION_TRACE: '1',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
        TEMP: isolatedTemp,
        TMP: isolatedTemp,
        TMPDIR: isolatedTemp,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (exitCode, signal) => {
      resolvePromise({
        args,
        elapsedMs: Date.now() - startedAtMs,
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function measureDirectory(root) {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
      }
    }
  }
  return { files, bytes };
}

function parseNobleResolutionTrace(output) {
  const results = [];
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const marker = '[metro:resolve] ';
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) continue;
    try {
      const value = JSON.parse(line.slice(markerIndex + marker.length));
      results.push({
        specifier: value?.specifier ?? null,
        origin: value?.origin ? 'absolute_path_observed_and_withheld' : null,
        platform: value?.platform ?? null,
      });
    } catch {
      results.push({ specifier: 'unparseable', origin: null, platform: null });
    }
  }
  return results;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? Math.round((ordered[middle - 1] + ordered[middle]) / 2)
    : ordered[middle];
}

const runCount = positiveInteger(readArgument('runs'), 3);
const keepOutputs = process.argv.includes('--keep-output');
const requestedArtifactPath = readArgument('artifact');
const artifactPath = requestedArtifactPath
  ? resolve(requestedArtifactPath)
  : join(repoRoot, '.project', 'qa', `cold-web-bundle-${artifactTimestamp()}.json`);
const sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
}).stdout?.trim() || 'unavailable';
const metroConfigSha256 = createHash('sha256')
  .update(await readFile(metroConfigPath))
  .digest('hex');
const noblePatchSha256 = createHash('sha256')
  .update(await readFile(noblePatchPath))
  .digest('hex');

const artifact = {
  contractVersion: 1,
  operation: 'happier_cold_web_bundle_baseline',
  sourceHead,
  metroConfigSha256,
  noblePatchSha256,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  requestedRuns: runCount,
  completedRuns: 0,
  cachePolicy: 'isolated TEMP/TMP/EXPO_HOME plus expo export -c for every run',
  runs: [],
  summary: null,
};

for (let index = 0; index < runCount; index += 1) {
  const isolatedRoot = await mkdtemp(join(tmpdir(), `happier-cold-bundle-${index + 1}-`));
  const outputDir = join(isolatedRoot, 'dist');
  await mkdir(join(isolatedRoot, 'tmp'), { recursive: true });
  process.stderr.write(`[cold-bundle] run ${index + 1}/${runCount} started\n`);
  try {
    const result = await runExpoExport({ outputDir, isolatedRoot });
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const output = result.exitCode === 0
      ? await measureDirectory(outputDir)
      : { files: 0, bytes: 0 };
    const run = {
      run: index + 1,
      elapsedMs: result.elapsedMs,
      exitCode: result.exitCode,
      signal: result.signal,
      output,
      nobleResolutionTrace: parseNobleResolutionTrace(combinedOutput),
      nobleResolutionWarningCount: (
        combinedOutput.match(/@noble\/hashes.*(?:warning|warn|unable|failed|invalid)/giu) ?? []
      ).length,
    };
    artifact.runs.push(run);
    if (result.exitCode !== 0) break;
    artifact.completedRuns += 1;
    process.stderr.write(`[cold-bundle] run ${index + 1}/${runCount} completed in ${result.elapsedMs}ms\n`);
  } finally {
    if (!keepOutputs) {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }
}

const successfulDurations = artifact.runs
  .filter((run) => run.exitCode === 0)
  .map((run) => run.elapsedMs);
artifact.finishedAt = new Date().toISOString();
artifact.summary = successfulDurations.length > 0
  ? {
      minMs: Math.min(...successfulDurations),
      medianMs: median(successfulDurations),
      maxMs: Math.max(...successfulDurations),
      allRunsSucceeded: artifact.completedRuns === runCount,
      nobleResolutionWarnings: artifact.runs.reduce(
        (total, run) => total + run.nobleResolutionWarningCount,
        0,
      ),
    }
  : {
      minMs: null,
      medianMs: null,
      maxMs: null,
      allRunsSucceeded: false,
      nobleResolutionWarnings: null,
    };

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ artifactPath, ...artifact.summary })}\n`);
if (!artifact.summary.allRunsSucceeded) process.exitCode = 1;
