import type { Message } from '@/sync/domains/messages/messageTypes';

const MAX_STREAMING_PREVIEW_LENGTH = 124;

export function resolveSessionStreamingPreview(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.kind !== 'agent-text' || message.isThinking === true) continue;
        const normalized = message.text.replace(/\s+/g, ' ').trim();
        if (!normalized) continue;
        if (normalized.length <= MAX_STREAMING_PREVIEW_LENGTH) return normalized;
        return `…${normalized.slice(-(MAX_STREAMING_PREVIEW_LENGTH - 1))}`;
    }
    return null;
}
