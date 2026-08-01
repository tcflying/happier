import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildExpoExportLaunch,
  buildUiGatewayLaunch,
  parseFastWebPreviewArgs,
} from './fastWebPreview.mjs';

test('fast web preview parses an explicit local runtime configuration', () => {
  const parsed = parseFastWebPreviewArgs([
    '--port=19087',
    '--backend-url=http://127.0.0.1:53337',
    '--minio-port=9000',
    '--bucket=happier-local',
    '--ui-dir=D:/runtime/happier-ui',
    '--skip-export',
  ], {});

  assert.deepEqual(parsed, {
    port: 19087,
    backendUrl: 'http://127.0.0.1:53337',
    minioPort: 9000,
    bucket: 'happier-local',
    uiDir: 'D:/runtime/happier-ui',
    skipExport: true,
    clearExportCache: false,
  });
});

test('fast web preview builds production export and cacheable gateway launches', () => {
  const config = parseFastWebPreviewArgs([
    '--port=19087',
    '--backend-url=http://127.0.0.1:53337',
    '--ui-dir=D:/runtime/happier-ui',
    '--clear-export-cache',
  ], {});

  assert.deepEqual(buildExpoExportLaunch({
    config,
    uiDir: 'D:/repo/apps/ui',
    repoRoot: 'D:/repo',
  }), {
    command: process.execPath,
    args: [
      'D:/repo/node_modules/expo/bin/cli',
      'export',
      '--platform',
      'web',
      '--output-dir',
      'D:/runtime/happier-ui',
      '-c',
    ],
    cwd: 'D:/repo/apps/ui',
  });
  assert.deepEqual(buildUiGatewayLaunch({
    config,
    repoRoot: 'D:/repo',
  }), {
    command: process.execPath,
    args: [
      'D:/repo/apps/stack/scripts/ui_gateway.mjs',
      '--port=19087',
      '--backend-url=http://127.0.0.1:53337',
      '--minio-port=9000',
      '--bucket=happier',
      '--ui-dir=D:/runtime/happier-ui',
    ],
    cwd: 'D:/repo',
  });
});

test('fast web preview rejects invalid ports before starting processes', () => {
  assert.throws(
    () => parseFastWebPreviewArgs(['--port=0'], {}),
    /port must be a positive integer/,
  );
});

test('fast web preview defaults to the Happier web port and ignores empty backend overrides', () => {
  const parsed = parseFastWebPreviewArgs([], {
    HAPPIER_SERVER_URL: '',
    HAPPIER_UI_FAST_PREVIEW_BACKEND_URL: 'http://127.0.0.1:53337',
  });

  assert.equal(parsed.port, 19087);
  assert.equal(parsed.backendUrl, 'http://127.0.0.1:53337');
});
