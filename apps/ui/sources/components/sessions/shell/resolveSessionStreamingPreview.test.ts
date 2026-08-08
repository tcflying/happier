import { describe, expect, it } from 'vitest';

import { resolveSessionStreamingPreview } from './resolveSessionStreamingPreview';

describe('resolveSessionStreamingPreview', () => {
    it('uses the newest agent event, tool result, or nested child rather than user text', () => {
        expect(resolveSessionStreamingPreview([
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'old answer' },
            { kind: 'tool-call', id: 't', localId: null, createdAt: 2, tool: { name: 'Exec', state: 'running', result: { output: 'tests 41/42' } }, children: [] },
            { kind: 'user-text', id: 'u', localId: null, createdAt: 3, text: 'ignore' },
        ] as any)).toBe('2');
    });

    it('keeps a complete Unicode character intact', () => {
        expect(resolveSessionStreamingPreview([{ kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'tail 😀' }] as any)).toBe('😀');
    });

    it('reads normal body text, thinking text, and agent events', () => {
        expect(resolveSessionStreamingPreview([{ kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: '正文完成。' }] as any)).toBe('。');
        expect(resolveSessionStreamingPreview([{ kind: 'agent-text', id: 'r', localId: null, createdAt: 1, text: '正在思考中', isThinking: true }] as any)).toBe('中');
        expect(resolveSessionStreamingPreview([{ kind: 'agent-event', id: 'e', createdAt: 1, event: { message: '压缩 37%' } }] as any)).toBe('%');
    });
});
