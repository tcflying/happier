import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStackWebExportEnv } from '../../stack/scripts/utils/ui/ui_export_env.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const uiDirForScript = resolve(dirname(scriptPath), '..');
const repoRootForScript = resolve(uiDirForScript, '..', '..');

function readValue(argv, name, envValue, fallback) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  const value = argument ? argument.slice(prefix.length) : String(envValue ?? fallback ?? '');
  return value.trim();
}

function readPositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function portableJoin(root, ...segments) {
  const normalizedRoot = String(root).replace(/\\/g, '/').replace(/\/$/u, '');
  return [normalizedRoot, ...segments.map((segment) => String(segment).replace(/^\/+|\/+$/gu, ''))].join('/');
}

export function parseFastWebPreviewArgs(argv, env = process.env) {
  const port = readPositiveInteger(
    readValue(argv, 'port', env.HAPPIER_UI_FAST_PREVIEW_PORT, '19087'),
    'port',
  );
  const minioPort = readPositiveInteger(
    readValue(argv, 'minio-port', env.HAPPIER_MINIO_PORT, '9000'),
    'minio-port',
  );
  const backendEnvValue = [
    env.HAPPIER_SERVER_URL,
    env.HAPPIER_UI_FAST_PREVIEW_BACKEND_URL,
  ].find((value) => String(value ?? '').trim().length > 0);
  const backendUrl = readValue(
    argv,
    'backend-url',
    backendEnvValue,
    'http://127.0.0.1:3005',
  );
  try {
    const parsed = new URL(backendUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error('backend-url must be an absolute HTTP(S) URL');
  }

  const bucket = readValue(argv, 'bucket', env.HAPPIER_MINIO_BUCKET, 'happier');
  if (!bucket) throw new Error('bucket must not be empty');
  const uiDir = readValue(argv, 'ui-dir', env.HAPPIER_UI_FAST_PREVIEW_DIR, 'dist-fast');
  if (!uiDir) throw new Error('ui-dir must not be empty');

  return {
    port,
    backendUrl,
    minioPort,
    bucket,
    uiDir,
    skipExport: argv.includes('--skip-export'),
    clearExportCache: argv.includes('--clear-export-cache'),
  };
}

export function buildExpoExportLaunch({ config, uiDir, repoRoot }) {
  return {
    command: process.execPath,
    args: [
      portableJoin(repoRoot, 'node_modules', 'expo', 'bin', 'cli'),
      'export',
      '--platform',
      'web',
      '--output-dir',
      config.uiDir,
      ...(config.clearExportCache ? ['-c'] : []),
    ],
    cwd: uiDir,
  };
}

export function buildUiGatewayLaunch({ config, repoRoot }) {
  return {
    command: process.execPath,
    args: [
      portableJoin(repoRoot, 'apps', 'stack', 'scripts', 'ui_gateway.mjs'),
      `--port=${config.port}`,
      `--backend-url=${config.backendUrl}`,
      `--minio-port=${config.minioPort}`,
      `--bucket=${config.bucket}`,
      `--ui-dir=${config.uiDir}`,
    ],
    cwd: repoRoot,
  };
}

function runChild(launch, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, child }));
    options.onStart?.(child);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write([
      'Usage: yarn --cwd apps/ui web:fast --port=<port> --backend-url=<url> [options]',
      '  --ui-dir=<path>           Export directory (default: dist-fast)',
      '  --skip-export             Serve an existing export',
      '  --clear-export-cache      Pass -c to Expo export',
      '  --minio-port=<port>       Local object storage port (default: 9000)',
      '  --bucket=<name>           Local object storage bucket (default: happier)',
      '',
    ].join('\n'));
    return;
  }

  const parsed = parseFastWebPreviewArgs(argv);
  const config = {
    ...parsed,
    uiDir: resolve(uiDirForScript, parsed.uiDir),
  };

  if (!config.skipExport) {
    const exportLaunch = buildExpoExportLaunch({
      config,
      uiDir: uiDirForScript,
      repoRoot: repoRootForScript,
    });
    const exportResult = await runChild(exportLaunch, {
      env: {
        ...buildStackWebExportEnv({ baseEnv: process.env }),
        EXPO_NO_TELEMETRY: '1',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
      },
    });
    if (exportResult.code !== 0) {
      throw new Error(`Expo web export failed${exportResult.signal ? ` (${exportResult.signal})` : ''}`);
    }
  }

  if (!existsSync(resolve(config.uiDir, 'index.html'))) {
    throw new Error(`Fast web preview export is missing index.html: ${config.uiDir}`);
  }

  const gatewayLaunch = buildUiGatewayLaunch({ config, repoRoot: repoRootForScript });
  let gateway = null;
  const stopGateway = () => {
    if (!gateway || gateway.killed) return;
    gateway.kill();
  };
  process.once('SIGINT', stopGateway);
  process.once('SIGTERM', stopGateway);
  const gatewayResult = await runChild(gatewayLaunch, {
    onStart: (child) => {
      gateway = child;
    },
  });
  if (gatewayResult.code !== 0 && gatewayResult.signal == null) {
    throw new Error(`Fast web preview gateway exited with code ${String(gatewayResult.code)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
