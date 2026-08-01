import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

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

  it('marks markdown images inside the selected Codex home as trusted direct-session media', () => {
    const codexHome = join('C:', 'Users', 'alice', '.codex');
    const imagePath = join(codexHome, 'visualizations', 'proof.png').replace(/\\/g, '/');
    const [message] = mapCodexRolloutLineToDirectMessages({
      fileRelPath: 'sessions/2026/08/01/rollout.jsonl',
      lineStartOffsetBytes: 240,
      lineValue: {
        timestamp: '2026-08-01T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg_assistant_image',
          role: 'assistant',
        },
      },
      actions: [{
        type: 'assistant-text',
        text: `Evidence:\n\n![proof](${imagePath})`,
      }],
      providerMediaRoot: codexHome,
    });

    expect(message?.raw).toMatchObject({
      role: 'agent',
      meta: {
        happierDirectMedia: {
          kind: 'direct_session_media.v1',
          payload: {
            media: [{
              role: 'output',
              category: 'generated',
              mediaKind: 'image',
              name: 'proof.png',
              path: imagePath,
              mimeType: 'image/png',
              sizeBytes: 0,
            }],
          },
        },
      },
    });
  });

  it('does not trust markdown image paths outside the selected Codex home', () => {
    const [message] = mapCodexRolloutLineToDirectMessages({
      fileRelPath: 'sessions/2026/08/01/rollout.jsonl',
      lineStartOffsetBytes: 360,
      lineValue: {
        timestamp: '2026-08-01T08:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg_assistant_untrusted_image',
          role: 'assistant',
        },
      },
      actions: [{
        type: 'assistant-text',
        text: '![secret](C:/Users/alice/Documents/secret.png)',
      }],
      providerMediaRoot: 'C:/Users/alice/.codex',
    });

    expect(message?.raw).not.toHaveProperty('meta.happierDirectMedia');
  });

  it('marks trusted user markdown images as input attachments', () => {
    const imagePath = 'C:/Users/alice/.codex/visualizations/input.png';
    const [message] = mapCodexRolloutLineToDirectMessages({
      fileRelPath: 'sessions/2026/08/01/rollout.jsonl',
      lineStartOffsetBytes: 480,
      lineValue: { timestamp: '2026-08-01T08:00:00.000Z' },
      actions: [{ type: 'user-text', text: `Review ![input](${imagePath})` }],
      providerMediaRoot: 'C:/Users/alice/.codex',
    });

    expect(message?.raw).toMatchObject({
      role: 'user',
      meta: {
        happierDirectMedia: {
          kind: 'direct_session_media.v1',
          payload: {
            media: [expect.objectContaining({
              role: 'input',
              category: 'attachment',
              path: imagePath,
            })],
          },
        },
      },
    });
  });
});
