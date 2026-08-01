import { describe, expect, it } from 'vitest';

import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';

describe('mapCodexRolloutLineToDirectMessages', () => {
  it('reuses the app-server assistant stream identity for the final rollout item', () => {
    const [message] = mapCodexRolloutLineToDirectMessages({
      fileRelPath: 'rollout-main.jsonl',
      lineStartOffsetBytes: 120,
      lineValue: {
        timestamp: '2026-08-01T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg_assistant_1',
          role: 'assistant',
        },
      },
      actions: [{ type: 'assistant-text', text: 'final answer' }],
    });

    expect(message).toMatchObject({
      localId: 'codex-stream:assistant:msg_assistant_1',
      raw: {
        role: 'agent',
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'codex-stream:assistant:msg_assistant_1',
            segmentState: 'complete',
            startedAtMs: Date.parse('2026-08-01T08:00:00.000Z'),
            updatedAtMs: Date.parse('2026-08-01T08:00:00.000Z'),
          },
        },
      },
    });
  });
});
