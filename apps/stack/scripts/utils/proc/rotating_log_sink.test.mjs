import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRotatingRedactingLogSink,
  sanitizeRuntimeLogText,
} from './rotating_log_sink.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'happier-rotating-log-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function finish(stream) {
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

test('runtime log sanitizer redacts credentials and hashes stable identities', () => {
  const raw = [
    'Authorization: Bearer secret-bearer-value',
    'Cookie: session=secret-cookie-value; preference=secret-cookie-preference',
    'User-Agent: secret-user-agent',
    'refreshToken=secret-refresh-value',
    'sessionSecret: secret-session-value',
    'OPENAI_API_KEY=sk-secret-openai-value',
    'sessionId=019f5569-6e91-7eb2-9460-5c1ccc32a8a7',
    'machineId="machine-alpha"',
    'socketId=socket-alpha',
    'remoteAddress=192.168.1.23',
    'workspace="C:\\Users\\datoo\\Secret Project"',
    'unixPath=/home/alice/private-repository',
  ].join('\n');

  const first = sanitizeRuntimeLogText(raw);
  const second = sanitizeRuntimeLogText(raw);

  for (const secret of [
    'secret-bearer-value',
    'secret-cookie-value',
    'secret-cookie-preference',
    'secret-user-agent',
    'secret-refresh-value',
    'secret-session-value',
    'sk-secret-openai-value',
    '019f5569-6e91-7eb2-9460-5c1ccc32a8a7',
    'machine-alpha',
    'socket-alpha',
    '192.168.1.23',
    'C:\\Users\\datoo\\Secret Project',
    '/home/alice/private-repository',
  ]) {
    assert.equal(first.includes(secret), false, `must not retain ${secret}`);
  }
  assert.match(first, /Authorization: \[REDACTED\]/);
  assert.match(first, /Cookie: \[REDACTED\]/);
  assert.match(first, /User-Agent: \[REDACTED\]/);
  assert.match(first, /sessionId=id#[a-f0-9]{12}/);
  assert.match(first, /machineId="id#[a-f0-9]{12}"/);
  assert.match(first, /socketId=id#[a-f0-9]{12}/);
  assert.match(first, /remoteAddress=id#[a-f0-9]{12}/);
  assert.match(first, /workspace="path#[a-f0-9]{12}"/);
  assert.match(first, /unixPath=path#[a-f0-9]{12}/);
  assert.equal(first, second, 'identity hashes must remain stable');
});

test('rotating sink redacts credentials split across write chunks', async (t) => {
  const root = await withTempRoot(t);
  const logPath = join(root, 'runtime.log');
  const sink = createRotatingRedactingLogSink({ logPath, maxBytes: 4096 });

  sink.write('refreshTo');
  sink.write('ken=split-refresh-secret\nCookie: session=split-cookie; ');
  sink.write('preference=split-preference\nsocket');
  sink.write('Id=split-socket\n');
  await finish(sink);

  const raw = await readFile(logPath, 'utf8');
  for (const secret of [
    'split-refresh-secret',
    'split-cookie',
    'split-preference',
    'split-socket',
  ]) {
    assert.equal(raw.includes(secret), false, `must not retain split secret ${secret}`);
  }
  assert.match(raw, /refreshToken=\[REDACTED\]/);
  assert.match(raw, /Cookie: \[REDACTED\]/);
  assert.match(raw, /socketId=id#[a-f0-9]{12}/);
});

test('rotating sink enforces size and time rotation over a simulated 24 hour run', async (t) => {
  const root = await withTempRoot(t);
  const logPath = join(root, 'runtime.log');
  let nowMs = Date.parse('2026-07-27T00:00:00.000Z');
  const sink = createRotatingRedactingLogSink({
    logPath,
    maxBytes: 320,
    maxAgeMs: 60 * 60 * 1000,
    maxFiles: 4,
    now: () => nowMs,
  });

  for (let hour = 0; hour < 24; hour += 1) {
    nowMs += 60 * 60 * 1000;
    sink.write(
      `hour=${hour} sessionId=session-stable refreshToken=refresh-secret-${hour} ` +
        `${'payload '.repeat(18)}\n`
    );
  }
  await finish(sink);

  const files = (await readdir(root)).filter((name) => name.startsWith('runtime.log'));
  assert.ok(files.length <= 4, `expected at most 4 retained files, got ${files.length}`);

  let totalBytes = 0;
  let all = '';
  for (const file of files) {
    totalBytes += (await stat(join(root, file))).size;
    all += await readFile(join(root, file), 'utf8');
  }
  assert.ok(totalBytes <= 4 * 520, `retained bytes must stay bounded, got ${totalBytes}`);
  assert.equal(all.includes('refresh-secret-'), false);
  assert.equal(all.includes('session-stable'), false);
  assert.match(all, /sessionId=id#[a-f0-9]{12}/);
});
