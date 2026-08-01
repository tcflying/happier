import { open } from 'node:fs/promises';

const DEFAULT_TAIL_BYTES = 64 * 1024;
const ACTIVITY_TEXT_KEYS = [
  'last_agent_message',
  'message',
  'text',
  'output',
  'input',
  'delta',
  'content',
  'arguments',
  'command',
] as const;
const IGNORED_FALLBACK_EVENT_TYPES = new Set([
  'token_count',
  'thread_settings_applied',
]);

function normalizeActivityText(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function findActivityText(value: unknown, depth = 0): string | null {
  if (depth > 16 || value == null) return null;
  if (typeof value === 'string') {
    return normalizeActivityText(value);
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = findActivityText(value[index], depth + 1);
      if (text) return text;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ACTIVITY_TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const text = findActivityText(record[key], depth + 1);
      if (text) return text;
    }
  }
  return null;
}

function resolveRecordActivityCharacter(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : record;
  const activityText = findActivityText(payload);
  if (activityText) return Array.from(activityText).at(-1) ?? null;

  const payloadType = typeof payload.type === 'string' ? payload.type.trim() : '';
  if (payloadType && !IGNORED_FALLBACK_EVENT_TYPES.has(payloadType)) {
    return Array.from(payloadType).at(-1) ?? null;
  }
  return null;
}

export function resolveCodexRolloutActivityTailCharacter(rawTail: string): string | null {
  const lines = rawTail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const character = resolveRecordActivityCharacter(JSON.parse(line));
      if (character) return character;
    } catch {
      // The writer may be midway through the newest JSONL record. The previous
      // complete record is still authoritative until that write is complete.
    }
  }
  return null;
}

export async function readCodexRolloutActivityTailCharacter(
  filePath: string,
  tailBytes = DEFAULT_TAIL_BYTES,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stat = await handle.stat();
    const length = Math.max(0, Math.min(stat.size, Math.max(1, Math.trunc(tailBytes))));
    if (length === 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return resolveCodexRolloutActivityTailCharacter(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
