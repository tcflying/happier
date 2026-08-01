import type { Message } from '@/sync/domains/messages/messageTypes';

function finalCharacter(value: unknown, depth = 0): string | null {
    if (depth > 12 || value == null) return null;

    if (typeof value === 'string') {
        const normalized = value.replace(/\s+/g, ' ').trim();
        return normalized ? (Array.from(normalized).at(-1) ?? null) : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return Array.from(String(value)).at(-1) ?? null;
    }
    if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
            const character = finalCharacter(value[index], depth + 1);
            if (character) return character;
        }
        return null;
    }
    if (typeof value === 'object') {
        const values = Object.values(value as Record<string, unknown>);
        for (let index = values.length - 1; index >= 0; index -= 1) {
            const character = finalCharacter(values[index], depth + 1);
            if (character) return character;
        }
    }
    return null;
}

function finalAgentActivityCharacter(message: Message): string | null {
    if (message.kind === 'user-text') return null;
    if (message.kind === 'agent-text') return finalCharacter(message.text);
    if (message.kind === 'agent-event') return finalCharacter(message.event);

    for (let index = message.children.length - 1; index >= 0; index -= 1) {
        const character = finalAgentActivityCharacter(message.children[index]!);
        if (character) return character;
    }

    // Order these from stable invocation data to live completion data. The
    // reverse-reading helper therefore prefers child activity, streamed result,
    // permission/status changes, and only then the original input/name.
    return finalCharacter([
        message.tool.name,
        message.tool.input,
        message.tool.description,
        message.tool.state,
        message.tool.permission,
        message.tool.result,
    ]);
}

export function resolveSessionStreamingPreview(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) continue;
        const character = finalAgentActivityCharacter(message);
        if (character) return character;
    }
    return null;
}
