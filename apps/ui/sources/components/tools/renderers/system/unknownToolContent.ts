import { maybeParseJson } from '../../normalization/parse/parseJson';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function stringifyShort(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function flattenTextBlocks(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const textBlocks = value as Array<{ type?: unknown; text?: unknown }>;
    if (!textBlocks.every((block) => (
        block
        && typeof block === 'object'
        && (block.type === 'text' || block.type === 'input_text')
        && typeof block.text === 'string'
    ))) {
        return null;
    }
    return textBlocks.map((block) => block.text as string).join('');
}

export function formatUnknownToolSubtitle(input: unknown): string {
    const parsed = maybeParseJson(input);
    const inputObj = asRecord(parsed);
    if (!inputObj) {
        return typeof parsed === 'string' ? truncate(parsed.trim(), 280) : '';
    }
    const keys = Object.keys(inputObj).filter((key) => !key.startsWith('_')).slice(0, 3);
    if (keys.length === 0) return '';
    const parts = keys.map((key) => `${key}=${truncate(stringifyShort(inputObj[key]), 120)}`);
    return truncate(parts.join(' '), 280);
}

export function formatUnknownToolInputText(input: unknown): string {
    const parsed = maybeParseJson(input);
    if (typeof parsed === 'string') return parsed;
    try {
        return JSON.stringify(parsed, null, 2);
    } catch {
        return String(parsed ?? '');
    }
}

export function formatUnknownToolResultText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string') return parsed;
    const flattened = flattenTextBlocks(parsed);
    if (flattened !== null) return flattened;

    const obj = asRecord(parsed);
    if (!obj) return null;
    const candidates = [obj.text, obj.message, obj.result, obj.output, obj.stdout];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
        const candidateBlocks = flattenTextBlocks(candidate);
        if (candidateBlocks !== null) return candidateBlocks;
    }
    return null;
}

export function shouldShowUnknownToolResult(tool: Readonly<{ state: string; result?: unknown }>): boolean {
    return (tool.state === 'running' || tool.state === 'completed' || tool.state === 'error') && tool.result != null;
}
