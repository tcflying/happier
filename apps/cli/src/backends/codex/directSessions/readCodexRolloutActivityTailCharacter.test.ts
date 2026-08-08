import { describe, expect, it } from 'vitest';

import { resolveCodexRolloutActivityTailCharacter } from './readCodexRolloutActivityTailCharacter';

describe('resolveCodexRolloutActivityTailCharacter', () => {
  it('uses the newest complete activity record and ignores a partial JSONL suffix', () => {
    const raw = `${JSON.stringify({ type: 'event_msg', payload: { message: '实时流😀' } })}\n{"payload":{"output":"partial`;

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('😀');
  });

  it('prefers a completion message over trailing metadata scalars', () => {
    const raw = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tail-id', last_agent_message: 'STREAM-DONE' } });

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('E');
  });

  it('reads reasoning summary text, normal body text, tool output, and agent events', () => {
    expect(resolveCodexRolloutActivityTailCharacter(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '正在推理中' }] },
    }))).toBe('中');
    expect(resolveCodexRolloutActivityTailCharacter(JSON.stringify({
      type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: '正文完成。' }] },
    }))).toBe('。');
    expect(resolveCodexRolloutActivityTailCharacter(JSON.stringify({
      type: 'response_item', payload: { type: 'custom_tool_call_output', output: { text: '42 tests passed' } },
    }))).toBe('d');
    expect(resolveCodexRolloutActivityTailCharacter(JSON.stringify({
      type: 'event_msg', payload: { type: 'agent_event', event: { message: '压缩 37%' } },
    }))).toBe('%');
  });

  it('skips structural event types instead of showing their final letter', () => {
    const raw = [
      JSON.stringify({ type: 'event_msg', payload: { message: '真实活动7' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_context' } }),
    ].join('\n');

    expect(resolveCodexRolloutActivityTailCharacter(raw)).toBe('7');
  });
});
