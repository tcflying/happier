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

function readToolText(value: unknown): string | null {
    if (typeof value === 'string') return value;
    const flattened = flattenTextBlocks(value);
    if (flattened !== null) return flattened;

    const record = asRecord(value);
    if (!record) return null;
    for (const key of ['text', 'message', 'result', 'output', 'content', 'stdout', 'stderr', 'error', 'details']) {
        const candidate = record[key];
        if (typeof candidate === 'string') return candidate;
        const candidateBlocks = flattenTextBlocks(candidate);
        if (candidateBlocks !== null) return candidateBlocks;
    }
    for (const key of ['error', 'details']) {
        const nested = asRecord(record[key]);
        if (typeof nested?.message === 'string') return nested.message;
        if (typeof nested?.text === 'string') return nested.text;
    }
    return null;
}

function summarizePayload(value: unknown): string {
    if (Array.isArray(value)) return `[${value.length} blocks]`;
    if (asRecord(value)) return '[object]';
    return `[${typeof value}]`;
}

export function formatUnknownToolSubtitle(input: unknown): string {
    const parsed = maybeParseJson(input);
    const text = readToolText(parsed);
    return text ? truncate(text.trim(), 280) : '';
}

export function formatUnknownToolInputText(input: unknown): string {
    const parsed = maybeParseJson(input);
    return readToolText(parsed) ?? summarizePayload(parsed);
}

export function formatUnknownToolResultText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    const text = readToolText(parsed);
    if (text !== null) return text.trim().length > 0 ? text : null;
    return summarizePayload(parsed);
}

export function shouldShowUnknownToolResult(tool: Readonly<{ state: string; result?: unknown }>): boolean {
    return (tool.state === 'running' || tool.state === 'completed' || tool.state === 'error') && tool.result != null;
}

export function resolveUnknownToolResultText(
    tool: Readonly<{ state: string; result?: unknown }>,
    emptyResultText: string,
): string | null {
    if (!shouldShowUnknownToolResult(tool)) return null;
    return formatUnknownToolResultText(tool.result) ?? emptyResultText;
}
