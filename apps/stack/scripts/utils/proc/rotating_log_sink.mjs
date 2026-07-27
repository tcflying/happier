import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 8;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stableIdentityHash(value) {
  return `id#${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

function stablePathHash(value) {
  return `path#${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

export function sanitizeRuntimeLogText(value) {
  let text = String(value ?? '');

  text = text.replace(/\bAuthorization\s*[:=][^\r\n]*/gi, 'Authorization: [REDACTED]');
  text = text.replace(/\bCookie\s*[:=][^\r\n]*/gi, 'Cookie: [REDACTED]');
  text = text.replace(/\bUser-Agent\s*[:=][^\r\n]*/gi, 'User-Agent: [REDACTED]');
  text = text.replace(
    /([?&](?:access_token|refresh_token|token|api_key|apikey|session_secret)=)[^&#\s]+/gi,
    '$1[REDACTED]'
  );
  text = text.replace(
    /(\b(?:accessToken|refreshToken|sessionSecret|apiKey|api_key|token|cookie|OPENAI_API_KEY|ANTHROPIC_API_KEY|HAPPIER_API_KEY)\b["']?\s*[:=]\s*)(["']?)([^\s,;}"']+)\2/gi,
    '$1$2[REDACTED]$2'
  );
  text = text.replace(
    /\b(?:sk|sk-proj|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_KEY]'
  );
  text = text.replace(
    /(\b(?:sessionId|nativeSessionId|machineId|accountId|userId|profileId|serverId|socketId|connectionId|deviceId|remoteAddress|remoteAddr|ipAddress)\b["']?\s*[:=]\s*)(["']?)([A-Za-z0-9._:/-]{3,})\2/gi,
    (_match, prefix, quote, identity) => `${prefix}${quote}${stableIdentityHash(identity)}${quote}`
  );
  text = text.replace(
    /(["'])([A-Za-z]:[\\/][^"'\r\n]+)\1/g,
    (_match, quote, path) => `${quote}${stablePathHash(path)}${quote}`
  );
  text = text.replace(
    /(^|[\s=:(,])([A-Za-z]:[\\/][^\s,;"')\]]+)/gm,
    (_match, prefix, path) => `${prefix}${stablePathHash(path)}`
  );
  text = text.replace(
    /(["'])(\/(?:Users|home|var|tmp|opt|srv|mnt|workspace|workspaces|repo|repos|project|projects)\/[^"'\r\n]+)\1/g,
    (_match, quote, path) => `${quote}${stablePathHash(path)}${quote}`
  );
  text = text.replace(
    /(^|[\s=:(,])(\/(?:Users|home|var|tmp|opt|srv|mnt|workspace|workspaces|repo|repos|project|projects)\/[^\s,;"')\]]+)/gm,
    (_match, prefix, path) => `${prefix}${stablePathHash(path)}`
  );

  return text;
}

function truncateEntry(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const marker = Buffer.from('\n[TRUNCATED_LOG_ENTRY]\n');
  const available = Math.max(0, maxBytes - marker.length);
  return Buffer.concat([bytes.subarray(0, available), marker]).toString('utf8');
}

function rotationTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function resolveLogRotationPolicy(env = process.env) {
  return {
    maxBytes: positiveInteger(env?.HAPPIER_STACK_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxAgeMs: positiveInteger(env?.HAPPIER_STACK_LOG_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
    maxFiles: positiveInteger(env?.HAPPIER_STACK_LOG_MAX_FILES, DEFAULT_MAX_FILES),
  };
}

export function createRotatingRedactingLogSink({
  logPath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxFiles = DEFAULT_MAX_FILES,
  now = Date.now,
} = {}) {
  const canonicalPath = String(logPath ?? '').trim();
  if (!canonicalPath) {
    throw new Error('logPath is required');
  }

  const effectiveMaxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
  const effectiveMaxAgeMs = positiveInteger(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const effectiveMaxFiles = positiveInteger(maxFiles, DEFAULT_MAX_FILES);
  const logDir = dirname(canonicalPath);
  const logBase = basename(canonicalPath);
  let initialized = false;
  let currentBytes = 0;
  let openedAtMs = 0;
  let rotationSequence = 0;
  let pendingText = '';
  let droppingOversizedEntry = false;

  async function initialize() {
    if (initialized) return;
    await mkdir(logDir, { recursive: true });
    const existing = await safeStat(canonicalPath);
    currentBytes = existing?.size ?? 0;
    openedAtMs = existing?.mtimeMs ?? now();
    initialized = true;
  }

  async function pruneRotatedFiles() {
    const entries = await readdir(logDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${logBase}.`) || !entry.name.endsWith('.rotated')) {
        continue;
      }
      const path = join(logDir, entry.name);
      const metadata = await safeStat(path);
      if (metadata) candidates.push({ path, mtimeMs: metadata.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
    const keepRotated = Math.max(0, effectiveMaxFiles - 1);
    for (const stale of candidates.slice(keepRotated)) {
      await unlink(stale.path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async function rotate(atMs) {
    if (currentBytes <= 0) {
      openedAtMs = atMs;
      return;
    }
    const rotatedPath = `${canonicalPath}.${rotationTimestamp(atMs)}.${rotationSequence}.rotated`;
    rotationSequence += 1;
    await rename(canonicalPath, rotatedPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    currentBytes = 0;
    openedAtMs = atMs;
    await pruneRotatedFiles();
  }

  async function appendSanitizedEntry(rawEntry) {
    if (!rawEntry) return;
    await initialize();
    const atMs = now();
    const sanitized = truncateEntry(sanitizeRuntimeLogText(rawEntry), effectiveMaxBytes);
    const entryBytes = Buffer.byteLength(sanitized);
    const ageExpired = currentBytes > 0 && atMs - openedAtMs >= effectiveMaxAgeMs;
    const sizeExceeded = currentBytes > 0 && currentBytes + entryBytes > effectiveMaxBytes;
    if (ageExpired || sizeExceeded) {
      await rotate(atMs);
    }
    await appendFile(canonicalPath, sanitized, 'utf8');
    currentBytes += entryBytes;
  }

  async function flushCompleteEntries() {
    const lastLineFeed = pendingText.lastIndexOf('\n');
    const lastCarriageReturn = pendingText.lastIndexOf('\r');
    const lastBoundary = Math.max(lastLineFeed, lastCarriageReturn);
    if (lastBoundary < 0) return;
    const complete = pendingText.slice(0, lastBoundary + 1);
    pendingText = pendingText.slice(lastBoundary + 1);
    await appendSanitizedEntry(complete);
  }

  function discardThroughNextBoundary(text) {
    if (!droppingOversizedEntry) return text;
    const lineFeed = text.indexOf('\n');
    const carriageReturn = text.indexOf('\r');
    let boundary = -1;
    if (lineFeed >= 0 && carriageReturn >= 0) boundary = Math.min(lineFeed, carriageReturn);
    else boundary = Math.max(lineFeed, carriageReturn);
    if (boundary < 0) return '';
    let next = boundary + 1;
    if (text[boundary] === '\r' && text[next] === '\n') next += 1;
    droppingOversizedEntry = false;
    return text.slice(next);
  }

  return new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      void (async () => {
        const incoming = discardThroughNextBoundary(String(chunk ?? ''));
        if (!incoming) return;
        pendingText += incoming;
        await flushCompleteEntries();
        if (Buffer.byteLength(pendingText) > effectiveMaxBytes) {
          await appendSanitizedEntry('[OVERSIZED_LOG_ENTRY_REDACTED]\n');
          pendingText = '';
          droppingOversizedEntry = true;
        }
      })().then(() => callback(), callback);
    },
    final(callback) {
      void (async () => {
        if (pendingText) {
          await appendSanitizedEntry(pendingText);
          pendingText = '';
        }
      })().then(() => callback(), callback);
    },
  });
}

export function createRuntimeLogSink(logPath, env = process.env) {
  return createRotatingRedactingLogSink({
    logPath,
    ...resolveLogRotationPolicy(env),
  });
}
