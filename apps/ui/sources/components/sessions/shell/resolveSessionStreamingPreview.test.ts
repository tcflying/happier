import { describe, expect, it } from 'vitest';

import { resolveSessionStreamingPreview } from './resolveSessionStreamingPreview';

describe('resolveSessionStreamingPreview', () => {
    it('uses the final character of the newest agent activity, including thinking', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello' },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'first answer' },
            { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, text: '  正在继续推理中  ', isThinking: true },
        ] as any)).toBe('中');
    });

    it('reads a complete Unicode character rather than splitting a surrogate pair', () => {
        const text = 'streamed tail 😀';

        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text },
        ] as any)).toBe('😀');
    });

    it('uses tool results and child activity instead of falling back to old body text', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'old answer' },
            {
                kind: 'tool-call',
                id: 't1',
                localId: null,
                createdAt: 2,
                tool: {
                    name: 'Exec',
                    state: 'running',
                    input: { command: 'pnpm test' },
                    result: { output: 'tests 41/42' },
                },
                children: [],
            },
        ] as any)).toBe('2');
    });

    it('uses the newest agent event and ignores later user text', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'agent-event', id: 'e1', createdAt: 1, event: { type: 'message', message: '正在压缩 37%' } },
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 2, text: 'do not show this' },
        ] as any)).toBe('%');
    });

    it('returns null when no agent-side activity has arrived', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello' },
        ] as any)).toBeNull();
    });
});
