type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function buildCodexStreamSegmentLocalId(
    kind: 'assistant' | 'thinking',
    itemId: string,
): string {
    return `codex-stream:${kind}:${itemId}`;
}

export function buildCodexStreamSegmentLocalIdFromStreamKey(streamKey: string): string {
    const parts = streamKey.split(':');
    const itemId = parts.at(-1) ?? streamKey;
    const kind = parts.at(-2) === 'reasoning' ? 'thinking' : 'assistant';
    return buildCodexStreamSegmentLocalId(kind, itemId);
}

export function readCodexRolloutResponseItemId(value: unknown): string | null {
    const envelope = asRecord(value);
    if (!envelope || envelope.type !== 'response_item') return null;
    const payload = asRecord(envelope.payload);
    return payload ? readNonEmptyString(payload.id) : null;
}
