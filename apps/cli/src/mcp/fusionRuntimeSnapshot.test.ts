import { describe, expect, it, vi } from 'vitest';

import {
  FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME,
  readFusionLocalRuntimeSnapshot,
  registerFusionLocalRuntimeSnapshotTool,
} from './fusionRuntimeSnapshot';

const NOW = '2026-07-20T03:06:00.000Z';
const CREDENTIALS = {
  token: 'test-token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
};

describe('Fusion local runtime snapshot MCP extension', () => {
  it('returns only validated ACP model metadata and labels all provider facts it cannot prove', async () => {
    const result = await readFusionLocalRuntimeSnapshot(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      {
        now: () => NOW,
        resolveSession: async () => ({
          state: 'found',
          sessionId: 'sess-1',
          active: true,
          updatedAt: '2026-07-20T03:05:00.000Z',
          metadata: {
            acpSessionModelsV1: {
              v: 1,
              provider: 'codex',
              currentModelId: 'gpt-5.5',
              updatedAt: Date.parse('2026-07-20T03:04:00.000Z'),
              availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
            },
          },
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      kind: 'fusion_local_runtime_snapshot',
      contractVersion: 1,
      session: { id: 'sess-1', activity: 'active', updatedAt: '2026-07-20T03:05:00.000Z' },
      runtime: {
        modelState: 'known',
        providerId: 'codex',
        currentModelId: 'gpt-5.5',
        modelObservedAt: '2026-07-20T03:04:00.000Z',
        modelReason: null,
      },
      limitations: {
        providerAccount: 'not_reported',
        providerQuota: 'not_reported',
        latency: 'not_reported',
        context: 'not_reported',
        tools: 'not_reported',
        quality: 'not_reported',
      },
      provenance: {
        source: 'happier_local_acp_metadata',
        transport: 'local_mcp_stdio',
      },
    });
    if (!result.ok) throw new Error('expected runtime snapshot');
    expect(result.snapshot.id).toMatch(/^happier-local-[a-f0-9]{64}$/u);
    expect(result.snapshot.capturedAt).toBe(NOW);
    expect(result.snapshot.expiresAt).toBe('2026-07-20T03:06:30.000Z');
  });

  it('does not fabricate a model when ACP metadata is absent or malformed', async () => {
    const result = await readFusionLocalRuntimeSnapshot(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      {
        now: () => NOW,
        resolveSession: async () => ({
          state: 'found',
          sessionId: 'sess-1',
          active: false,
          updatedAt: NOW,
          metadata: { acpSessionModelsV1: { v: 1, provider: 'codex', currentModelId: '' } },
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      session: { activity: 'inactive' },
      runtime: {
        modelState: 'unknown',
        providerId: null,
        currentModelId: null,
        modelReason: 'acp_model_metadata_invalid',
      },
    });
  });

  it('returns only a safe error code when the session source fails', async () => {
    const result = await readFusionLocalRuntimeSnapshot(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      {
        resolveSession: async () => {
          throw new Error('credential value must never be exposed');
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      kind: 'fusion_local_runtime_snapshot',
      errorCode: 'source_unavailable',
    });
  });

  it('registers only when the explicit local extension flag is enabled and keeps its handler session scoped', async () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const resolveSession = vi.fn(async () => ({
      state: 'found' as const,
      sessionId: 'sess-1',
      active: true,
      updatedAt: NOW,
      metadata: null,
    }));
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    };

    expect(registerFusionLocalRuntimeSnapshotTool({
      server,
      credentials: CREDENTIALS,
      resolveSessionId: () => 'sess-1',
      env: {},
    })).toEqual([]);

    expect(registerFusionLocalRuntimeSnapshotTool({
      server,
      credentials: CREDENTIALS,
      resolveSessionId: (args) => (args as { sessionId?: string }).sessionId ?? null,
      dependencies: { now: () => NOW, resolveSession },
      env: { HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1: '1' },
    })).toEqual([FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME]);

    const handler = registered.get(FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME);
    if (!handler) throw new Error('expected local runtime snapshot handler');
    const response = await handler({ sessionId: 'sess-1' }) as { content?: readonly { text?: string }[]; isError?: unknown };
    expect(response.isError).toBe(false);
    expect(JSON.parse(String(response.content?.[0]?.text))).toMatchObject({ ok: true, session: { id: 'sess-1' } });
    expect(resolveSession).toHaveBeenCalledTimes(1);
  });
});
