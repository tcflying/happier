import { describe, expect, it, vi } from 'vitest';

import {
  FUSION_RECONCILIATION_HISTORY_TOOL_NAME,
  readFusionReconciliationHistory,
  registerFusionReconciliationHistoryTool,
} from './fusionReconciliationHistory';

const CREDENTIALS = {
  token: 'test-token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
};

const CONTEXT = {
  encryptionKey: new Uint8Array([1, 2, 3, 4]),
  encryptionVariant: 'legacy' as const,
};

describe('Fusion reconciliation history MCP extension', () => {
  it('preserves exact user localIds with the server-issued afterSeq cursor contract', async () => {
    const fetchPage = vi.fn(async () => ({
      messages: [
        {
          id: 'server-user-1',
          seq: 1,
          localId: 'fusion-outbox-1',
          createdAt: 1_000,
          messageRole: 'user',
          content: { role: 'user', content: { type: 'text', text: 'continue exact session' } },
        },
        {
          id: 'server-agent-2',
          seq: 2,
          createdAt: 2_000,
          messageRole: 'agent',
          content: { role: 'agent', content: { type: 'text', text: 'ignored by reconciliation' } },
        },
      ],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: 2,
    }));

    const result = await readFusionReconciliationHistory(
      { credentials: CREDENTIALS, sessionId: 'sess-1', afterCursor: null, limit: 2 },
      {
        resolveSession: async () => ({ state: 'found', sessionId: 'sess-1', ctx: CONTEXT }),
        fetchPage,
        decryptPayload: ({ content }) => content,
      },
    );

    expect(fetchPage).toHaveBeenCalledWith({
      credentials: CREDENTIALS,
      sessionId: 'sess-1',
      afterSeq: 0,
      limit: 2,
    });
    expect(result).toEqual({
      ok: true,
      kind: 'fusion_reconciliation_history',
      contractVersion: 1,
      session: { id: 'sess-1' },
      page: {
        afterCursor: null,
        completeThroughCursor: '2',
        nextCursor: '2',
        truncated: true,
      },
      items: [
        {
          nativeMessageId: 'server-user-1',
          localMessageId: 'fusion-outbox-1',
          content: 'continue exact session',
          occurredAtMs: 1_000,
          cursor: '1',
        },
      ],
      provenance: {
        source: 'happier_local_encrypted_transcript',
        transport: 'local_mcp_stdio',
        sourceContractVersion: 1,
      },
    });
  });

  it('fails closed when the transcript source claims more history without the exact next afterSeq frontier', async () => {
    const result = await readFusionReconciliationHistory(
      { credentials: CREDENTIALS, sessionId: 'sess-1', afterCursor: '2', limit: 1 },
      {
        resolveSession: async () => ({ state: 'found', sessionId: 'sess-1', ctx: CONTEXT }),
        fetchPage: async () => ({
          messages: [{ id: 'server-user-3', seq: 3, localId: 'fusion-outbox-3', createdAt: 3_000 }],
          hasMore: true,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }),
        decryptPayload: ({ content }) => content,
      },
    );

    expect(result).toEqual({
      ok: false,
      kind: 'fusion_reconciliation_history',
      errorCode: 'source_unavailable',
    });
  });

  it('registers only through the explicit local extension flag and keeps every request session scoped', async () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const resolveSession = vi.fn(async () => ({ state: 'found' as const, sessionId: 'sess-1', ctx: CONTEXT }));
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    };

    expect(registerFusionReconciliationHistoryTool({
      server,
      credentials: CREDENTIALS,
      resolveSessionId: () => 'sess-1',
      env: {},
    })).toEqual([]);

    expect(registerFusionReconciliationHistoryTool({
      server,
      credentials: CREDENTIALS,
      resolveSessionId: (args) => (args as { sessionId?: string }).sessionId ?? null,
      dependencies: {
        resolveSession,
        fetchPage: async () => ({
          messages: [],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }),
      },
      env: { HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1: '1' },
    })).toEqual([FUSION_RECONCILIATION_HISTORY_TOOL_NAME]);

    const handler = registered.get(FUSION_RECONCILIATION_HISTORY_TOOL_NAME);
    if (!handler) throw new Error('expected reconciliation history handler');
    const response = await handler({ sessionId: 'sess-1', afterCursor: '9', limit: 1 }) as {
      content?: readonly { text?: string }[];
      isError?: unknown;
    };
    expect(response.isError).toBe(false);
    expect(JSON.parse(String(response.content?.[0]?.text))).toMatchObject({
      ok: true,
      session: { id: 'sess-1' },
      page: { afterCursor: '9', completeThroughCursor: '9', nextCursor: null, truncated: false },
    });
    expect(resolveSession).toHaveBeenCalledWith({ credentials: CREDENTIALS, sessionId: 'sess-1' });
  });
});
