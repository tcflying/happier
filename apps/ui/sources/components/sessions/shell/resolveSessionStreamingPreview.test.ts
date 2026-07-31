import { describe, expect, it } from 'vitest';

import { resolveSessionStreamingPreview } from './resolveSessionStreamingPreview';

describe('resolveSessionStreamingPreview', () => {
    it('uses the newest non-thinking agent text and normalizes it into one live line', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello' },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hidden thought', isThinking: true },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'first answer' },
            { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, text: '  latest\n streamed   words  ' },
        ] as any)).toBe('latest streamed words');
    });

    it('keeps the tail of a long streaming response so each update is visibly fresh', () => {
        const text = 'a'.repeat(120) + ' final live tail';

        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text },
        ] as any)).toBe(`…${'a'.repeat(107)} final live tail`);
    });

    it('returns null when no visible agent text has arrived', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'thinking', isThinking: true },
        ] as any)).toBeNull();
    });
});
