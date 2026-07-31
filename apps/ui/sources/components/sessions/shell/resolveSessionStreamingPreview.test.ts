import { describe, expect, it } from 'vitest';

import { resolveSessionStreamingPreview } from './resolveSessionStreamingPreview';

describe('resolveSessionStreamingPreview', () => {
    it('uses only the final character of the newest non-thinking agent text', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello' },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hidden thought', isThinking: true },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'first answer' },
            { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, text: '  latest\n streamed   words  ' },
        ] as any)).toBe('s');
    });

    it('reads a complete Unicode character rather than splitting a surrogate pair', () => {
        const text = 'streamed tail 😀';

        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text },
        ] as any)).toBe('😀');
    });

    it('returns null when no visible agent text has arrived', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'thinking', isThinking: true },
        ] as any)).toBeNull();
    });
});
