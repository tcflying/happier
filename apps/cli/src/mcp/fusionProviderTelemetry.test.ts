import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { sealConnectedServiceQuotaSnapshotCiphertext } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const { fetchSessionById, fetchSessionsPage } = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
}));

import {
  FUSION_PROVIDER_TELEMETRY_TOOL_NAME,
  isFusionProviderTelemetryExtensionEnabled,
  readFusionProviderTelemetryFromHappierHost,
  registerFusionProviderTelemetryTool,
  type FusionProviderTelemetryHostApiV1,
  type FusionProviderTelemetryHostDependenciesV1,
} from './fusionProviderTelemetry';

const NOW_MS = 1_700_000_000_000;
const OBSERVED_AT = new Date(NOW_MS - 100).toISOString();
const EXPIRES_AT = new Date(NOW_MS + 900).toISOString();
const CREDENTIALS = {
  token: 'test-token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
};

const SAFE_RESULT = {
  ok: true,
  kind: 'fusion_provider_telemetry',
  contractVersion: 1,
  state: 'reported',
  provider: 'codex',
  source: 'happier_persisted_in_band_provider_snapshot',
  freshness: 'fresh',
  observedAt: OBSERVED_AT,
  expiresAt: EXPIRES_AT,
  limitations: {
    providerAvailability: 'not_inferred',
    capacity: 'not_reported',
    onDemandProviderRefresh: 'not_attempted',
    accountIdentity: 'not_reported',
    rawSnapshot: 'not_reported',
  },
};

function withheld(reason: string) {
  return {
    ok: true,
    kind: 'fusion_provider_telemetry',
    contractVersion: 1,
    state: 'withheld',
    reason,
  };
}

function createCodexMetadata(params: Readonly<{
  profileId: string;
  groupId?: string;
}>): Record<string, unknown> {
  return {
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: params.profileId,
      ...(params.groupId ? { connectedServiceGroupId: params.groupId } : {}),
    }),
  };
}

function createQuotaSnapshot(profileId: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId,
    fetchedAt: NOW_MS - 100,
    staleAfterMs: 1_000,
    planLabel: 'private-plan',
    accountLabel: 'account-private@example.test',
    providerId: 'provider-private',
    activeAccountId: 'account-private-id',
    meters: [
      {
        meterId: 'private-meter-id',
        label: 'private metric',
        used: 42,
        limit: 100,
        remainingPct: 58,
        unit: 'requests',
        utilizationPct: 42,
        resetsAt: null,
        status: 'ok',
        modelId: 'private-model-id',
      },
    ],
    ...overrides,
  };
}

function createHostDependencies(params: Readonly<{
  metadata: Record<string, unknown> | null;
  api: FusionProviderTelemetryHostApiV1;
  accountMode?: 'plain' | 'e2ee' | 'unknown';
  nowMs?: number;
  sessionId?: string;
}>): FusionProviderTelemetryHostDependenciesV1 {
  return {
    resolveSessionMetadata: async () => params.metadata
      ? { sessionId: params.sessionId ?? 'sess-1', metadata: params.metadata }
      : null,
    createApi: async () => params.api,
    resolveAccountMode: async () => params.accountMode ?? 'plain',
    nowMs: () => params.nowMs ?? NOW_MS,
  };
}

describe('Fusion provider telemetry MCP extension', () => {
  it('remains unavailable until the explicit local extension flag is exactly enabled', () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    };

    expect(isFusionProviderTelemetryExtensionEnabled({
      HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: 'true',
    })).toBe(false);
    expect(registerFusionProviderTelemetryTool({
      server,
      credentials: CREDENTIALS,
      env: {},
    })).toEqual([]);
    expect(registered.size).toBe(0);

    expect(registerFusionProviderTelemetryTool({
      server,
      credentials: CREDENTIALS,
      env: { HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: '1' },
    })).toEqual([FUSION_PROVIDER_TELEMETRY_TOOL_NAME]);
    expect(registered.has(FUSION_PROVIDER_TELEMETRY_TOOL_NAME)).toBe(true);
  });

  it('accepts only a strict validated sessionId before invoking the host helper', async () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const resolveSessionMetadata = vi.fn(async () => null);
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    };

    registerFusionProviderTelemetryTool({
      server,
      credentials: CREDENTIALS,
      dependencies: {
        resolveSessionMetadata,
        createApi: async () => ({}),
        resolveAccountMode: async () => 'plain',
        nowMs: () => NOW_MS,
      },
      env: { HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: '1' },
    });

    const handler = registered.get(FUSION_PROVIDER_TELEMETRY_TOOL_NAME);
    if (!handler) throw new Error('expected telemetry handler');
    const response = await handler({ sessionId: 'sess-1', unexpected: 'rejected' }) as {
      content?: readonly { text?: string }[];
      isError?: boolean;
    };

    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content?.[0]?.text ?? '')).toEqual(withheld('invalid_request'));
    expect(resolveSessionMetadata).not.toHaveBeenCalled();
  });

  it('uses the explicit telemetry sessionId instead of a registration resolver rewrite', async () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const resolveSessionId = vi.fn(() => 'sess-other-session');
    const resolveSessionMetadata = vi.fn(async () => null);
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
        registered.set(name, handler);
      },
    };
    const registration = {
      server,
      credentials: CREDENTIALS,
      resolveSessionId,
      dependencies: {
        resolveSessionMetadata,
        createApi: async () => ({}),
        resolveAccountMode: async () => 'plain' as const,
        nowMs: () => NOW_MS,
      },
      env: { HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: '1' },
    };

    registerFusionProviderTelemetryTool(registration);
    const handler = registered.get(FUSION_PROVIDER_TELEMETRY_TOOL_NAME);
    if (!handler) throw new Error('expected telemetry handler');
    const response = await handler({ sessionId: 'sess-explicit-session' }) as {
      content?: readonly { text?: string }[];
      isError?: boolean;
    };

    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content?.[0]?.text ?? '')).toEqual(withheld('session_unresolved'));
    expect(resolveSessionId).not.toHaveBeenCalled();
    expect(resolveSessionMetadata).toHaveBeenCalledWith({
      credentials: CREDENTIALS,
      sessionId: 'sess-explicit-session',
    });
  });

  it('withholds a prefix-resolved session mismatch before reading a quota snapshot', async () => {
    const getConnectedServiceQuotaSnapshotPlain = vi.fn(async () => ({
      content: { t: 'plain' as const, v: createQuotaSnapshot('profile-private') },
      metadata: { fetchedAt: NOW_MS - 100, staleAfterMs: 1_000, status: 'ok' as const },
    }));

    const result = await readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-prefix' },
      {
        resolveSessionMetadata: async () => ({
          sessionId: 'sess-full-other-session',
          metadata: createCodexMetadata({ profileId: 'profile-private' }),
        }),
        createApi: async () => ({ getConnectedServiceQuotaSnapshotPlain }),
        resolveAccountMode: async () => 'plain',
        nowMs: () => NOW_MS,
      },
    );

    expect(result).toEqual(withheld('session_unresolved'));
    expect(getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
  });

  it('does not resolve a telemetry session input through a prefix scan', async () => {
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    fetchSessionById.mockResolvedValue(null);

    const result = await readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'short-session-id' },
      {
        createApi: async () => ({}),
        resolveAccountMode: async () => 'plain',
        nowMs: () => NOW_MS,
      },
    );

    expect(result).toEqual(withheld('session_unresolved'));
    expect(fetchSessionById).toHaveBeenCalledWith({
      token: 'test-token',
      sessionId: 'short-session-id',
    });
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('uses the current group active profile and returns only the fixed fresh-snapshot projection', async () => {
    const api: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'team-codex',
        activeProfileId: 'current-profile-private',
        members: [{ profileId: 'current-profile-private', enabled: true }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: createQuotaSnapshot('current-profile-private') },
        metadata: { fetchedAt: NOW_MS - 100, staleAfterMs: 1_000, status: 'ok' as const },
      })),
    };

    const result = await readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'fallback-profile-private', groupId: 'team-codex' }),
        api,
      }),
    );

    expect(result).toEqual(SAFE_RESULT);
    expect(api.getConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'current-profile-private',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('42');
    expect(serialized).not.toContain('58');
  });

  it('opens a persisted sealed snapshot locally without reading provider capacity data', async () => {
    const snapshot = createQuotaSnapshot('sealed-profile-private');
    const ciphertext = sealConnectedServiceQuotaSnapshotCiphertext({
      material: { type: 'legacy', secret: CREDENTIALS.encryption.secret },
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const api: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { fetchedAt: NOW_MS - 100, staleAfterMs: 1_000, status: 'ok' as const },
      })),
    };

    const result = await readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'sealed-profile-private' }),
        api,
        accountMode: 'e2ee',
      }),
    );

    expect(result).toEqual(SAFE_RESULT);
    expect(api.getConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'sealed-profile-private',
    });
  });

  it('withholds expired persisted snapshots as snapshot_stale', async () => {
    const staleApi: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: createQuotaSnapshot('profile-private', {
          fetchedAt: NOW_MS - 2_000,
          staleAfterMs: 1_000,
        }) },
        metadata: { fetchedAt: NOW_MS - 2_000, staleAfterMs: 1_000, status: 'ok' as const },
      })),
    };

    await expect(readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'profile-private' }),
        api: staleApi,
      }),
    )).resolves.toEqual(withheld('snapshot_stale'));
  });

  it('withholds persisted snapshots when now equals their expiry boundary', async () => {
    const boundaryApi: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: createQuotaSnapshot('profile-private', {
          fetchedAt: NOW_MS - 1_000,
          staleAfterMs: 1_000,
        }) },
        metadata: { fetchedAt: NOW_MS - 1_000, staleAfterMs: 1_000, status: 'ok' as const },
      })),
    };

    await expect(readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'profile-private' }),
        api: boundaryApi,
      }),
    )).resolves.toEqual(withheld('snapshot_stale'));
  });

  it('withholds missing, estimated, and error snapshots as snapshot_unavailable', async () => {
    const unavailableApi: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
    };
    const estimatedApi: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: createQuotaSnapshot('profile-private') },
        metadata: { fetchedAt: NOW_MS - 100, staleAfterMs: 1_000, status: 'estimated' as const },
      })),
    };
    const errorApi: FusionProviderTelemetryHostApiV1 = {
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: createQuotaSnapshot('profile-private') },
        metadata: { fetchedAt: NOW_MS - 100, staleAfterMs: 1_000, status: 'error' as const },
      })),
    };

    await expect(readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'profile-private' }),
        api: unavailableApi,
      }),
    )).resolves.toEqual(withheld('snapshot_unavailable'));
    await expect(readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'profile-private' }),
        api: estimatedApi,
      }),
    )).resolves.toEqual(withheld('snapshot_unavailable'));
    await expect(readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      createHostDependencies({
        metadata: createCodexMetadata({ profileId: 'profile-private' }),
        api: errorApi,
      }),
    )).resolves.toEqual(withheld('snapshot_unavailable'));
  });

  it('maps host failures to source_unavailable without leaking raw details', async () => {
    const rawFailure = 'provider-account=private-account-id';
    const failureResult = await readFusionProviderTelemetryFromHappierHost(
      { credentials: CREDENTIALS, sessionId: 'sess-1' },
      {
        resolveSessionMetadata: async () => {
          throw new Error(rawFailure);
        },
        createApi: async () => ({}),
        resolveAccountMode: async () => 'plain',
        nowMs: () => NOW_MS,
      },
    );

    expect(failureResult).toEqual(withheld('source_unavailable'));
    expect(JSON.stringify(failureResult)).not.toContain(rawFailure);
  });
});
