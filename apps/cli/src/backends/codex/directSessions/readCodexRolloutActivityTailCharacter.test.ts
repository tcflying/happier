import { describe, expect, it } from 'vitest';

import { resolveCodexRolloutActivityTailCharacter } from './readCodexRolloutActivityTailCharacter';

describe('resolveCodexRolloutActivityTailCharacter', () => {
  it('reads the final scalar character from the newest complete raw activity record', () => {
    const raw = [
      JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { message: '旧消息' } }),
      JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { message: '实时流😀' } }),
      '',
    ].join('\n');

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('😀');
  });

  it('falls back to the newest complete JSONL record while the next record is partial', () => {
    const raw = `${JSON.stringify({ payload: { output: 'tests 41/42' } })}\n{"payload":{"output":"partial`;

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('2');
  });

  it('prefers the newest activity text over trailing telemetry and metadata scalars', () => {
    const raw = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [{ type: 'output_text', text: 'QA-1\nQA-2\nQA-6\n' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-ending-in-c' },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', rate_limits: { credits: { balance: '0' } } },
      }),
      '',
    ].join('\n');

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('6');
  });

  it('uses the task completion message instead of the trailing turn id', () => {
    const raw = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: '019fb8c7-3c74-71b0-8198-8c357f82c6e1',
        last_agent_message: 'STREAM-QA-DONE',
      },
    });

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('E');
  });
});
