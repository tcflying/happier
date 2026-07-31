import type { Message } from '@/sync/domains/messages/messageTypes';

export function resolveSessionStreamingPreview(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.kind !== 'agent-text' || message.isThinking === true) continue;
        const normalized = message.text.replace(/\s+/g, ' ').trim();
        if (!normalized) continue;
        return Array.from(normalized).at(-1) ?? null;
    }
    return null;
}
