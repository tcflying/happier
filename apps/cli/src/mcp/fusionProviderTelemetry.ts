import { readSessionMetadataConnectedServiceBindings } from '@happier-dev/agents';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  openConnectedServiceQuotaSnapshotCiphertext,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { ApiClient } from '@/api/api';
import {
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
} from '@/daemon/connectedServices/parseConnectedServicesBindings';
import type { Credentials } from '@/persistence';
import { resolveExactSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';

export const FUSION_PROVIDER_TELEMETRY_TOOL_NAME = 'fusion_provider_telemetry_get';
export const FUSION_PROVIDER_TELEMETRY_CONTRACT_VERSION = 1 as const;

const SAFE_TEXT_MAX_LENGTH = 512;
const CODEX_CONNECTED_SERVICE_ID = 'openai-codex' as const;

export const fusionProviderTelemetryToolInputSchema = z.object({
  sessionId: z.string()
    .trim()
    .min(1)
    .max(SAFE_TEXT_MAX_LENGTH)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
}).strict();

type UnknownRecord = Record<string, unknown>;
type FusionProviderTelemetryWithheldReasonV1 =
  | 'invalid_request'
  | 'session_unresolved'
  | 'binding_unavailable'
  | 'snapshot_unavailable'
  | 'snapshot_stale'
  | 'source_unavailable';

type PersistedQuotaMetadataV1 = Readonly<{
  fetchedAt: number;
  staleAfterMs: number;
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
}>;

type PersistedQuotaSnapshotV1 = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  metadata: PersistedQuotaMetadataV1;
}>;

type ResolvedCodexBindingV1 = Readonly<{
  serviceId: typeof CODEX_CONNECTED_SERVICE_ID;
  profileId: string;
}>;

type ResolvedSessionMetadataV1 = Readonly<{
  sessionId: string;
  metadata: UnknownRecord;
}>;

export interface FusionProviderTelemetryHostApiV1 {
  readonly getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountMode>;
  readonly getConnectedServiceAuthGroup?: (params: Readonly<{
    serviceId: typeof CODEX_CONNECTED_SERVICE_ID;
    groupId: string;
  }>) => Promise<unknown>;
  readonly getConnectedServiceQuotaSnapshotPlain?: (params: Readonly<{
    serviceId: typeof CODEX_CONNECTED_SERVICE_ID;
    profileId: string;
  }>) => Promise<unknown>;
  readonly getConnectedServiceQuotaSnapshotSealed?: (params: Readonly<{
    serviceId: typeof CODEX_CONNECTED_SERVICE_ID;
    profileId: string;
  }>) => Promise<unknown>;
}

export interface FusionProviderTelemetryHostDependenciesV1 {
  readonly resolveSessionMetadata: (input: Readonly<{
    credentials: Credentials;
    sessionId: string;
  }>) => Promise<ResolvedSessionMetadataV1 | null>;
  readonly createApi: (credentials: Credentials) => Promise<FusionProviderTelemetryHostApiV1>;
  readonly resolveAccountMode: (api: FusionProviderTelemetryHostApiV1) => Promise<ConnectedServiceAccountMode>;
  readonly nowMs: () => number;
}

export type FusionProviderTelemetryResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly kind: 'fusion_provider_telemetry';
    readonly contractVersion: typeof FUSION_PROVIDER_TELEMETRY_CONTRACT_VERSION;
    readonly state: 'reported';
    readonly provider: 'codex';
    readonly source: 'happier_persisted_in_band_provider_snapshot';
    readonly freshness: 'fresh';
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly limitations: Readonly<{
      readonly providerAvailability: 'not_inferred';
      readonly capacity: 'not_reported';
      readonly onDemandProviderRefresh: 'not_attempted';
      readonly accountIdentity: 'not_reported';
      readonly rawSnapshot: 'not_reported';
    }>;
  }>
  | Readonly<{
    readonly ok: true;
    readonly kind: 'fusion_provider_telemetry';
    readonly contractVersion: typeof FUSION_PROVIDER_TELEMETRY_CONTRACT_VERSION;
    readonly state: 'withheld';
    readonly reason: FusionProviderTelemetryWithheldReasonV1;
  }>;

type McpToolRegistrar = Readonly<{
  registerTool: (name: string, meta: unknown, handler: (args: unknown) => Promise<unknown>) => void;
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > SAFE_TEXT_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function readCiphertext(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 1_000_000) return null;
  return value.length > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function withheldResult(reason: FusionProviderTelemetryWithheldReasonV1): FusionProviderTelemetryResultV1 {
  return {
    ok: true,
    kind: 'fusion_provider_telemetry',
    contractVersion: FUSION_PROVIDER_TELEMETRY_CONTRACT_VERSION,
    state: 'withheld',
    reason,
  };
}

function freshSnapshotResult(input: Readonly<{ observedAt: string; expiresAt: string }>): FusionProviderTelemetryResultV1 {
  return {
    ok: true,
    kind: 'fusion_provider_telemetry',
    contractVersion: FUSION_PROVIDER_TELEMETRY_CONTRACT_VERSION,
    state: 'reported',
    provider: 'codex',
    source: 'happier_persisted_in_band_provider_snapshot',
    freshness: 'fresh',
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    limitations: {
      providerAvailability: 'not_inferred',
      capacity: 'not_reported',
      onDemandProviderRefresh: 'not_attempted',
      accountIdentity: 'not_reported',
      rawSnapshot: 'not_reported',
    },
  };
}

function readPersistedQuotaMetadata(value: unknown): PersistedQuotaMetadataV1 | null {
  if (!isRecord(value)) return null;
  const fetchedAt = readNonNegativeInteger(value.fetchedAt);
  const staleAfterMs = readNonNegativeInteger(value.staleAfterMs);
  const status = value.status;
  if (fetchedAt === null || staleAfterMs === null || staleAfterMs < 1) return null;
  if (status !== 'ok' && status !== 'unavailable' && status !== 'estimated' && status !== 'error') return null;
  return { fetchedAt, staleAfterMs, status };
}

function parsePersistedPlainQuotaSnapshot(value: unknown): PersistedQuotaSnapshotV1 | null {
  if (!isRecord(value) || !isRecord(value.content) || value.content.t !== 'plain') return null;
  const parsedSnapshot = ConnectedServiceQuotaSnapshotV1Schema.safeParse(value.content.v);
  const metadata = readPersistedQuotaMetadata(value.metadata);
  return parsedSnapshot.success && metadata ? { snapshot: parsedSnapshot.data, metadata } : null;
}

function accountScopedMaterial(credentials: Credentials): Parameters<typeof openConnectedServiceQuotaSnapshotCiphertext>[0]['material'] {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function parsePersistedSealedQuotaSnapshot(params: Readonly<{
  credentials: Credentials;
  value: unknown;
}>): PersistedQuotaSnapshotV1 | null {
  if (!isRecord(params.value) || !isRecord(params.value.sealed)) return null;
  if (params.value.sealed.format !== 'account_scoped_v1') return null;
  const ciphertext = readCiphertext(params.value.sealed.ciphertext);
  const metadata = readPersistedQuotaMetadata(params.value.metadata);
  if (!ciphertext || !metadata) return null;
  const opened = openConnectedServiceQuotaSnapshotCiphertext({
    material: accountScopedMaterial(params.credentials),
    ciphertext,
  });
  const parsedSnapshot = ConnectedServiceQuotaSnapshotV1Schema.safeParse(opened?.value);
  return parsedSnapshot.success ? { snapshot: parsedSnapshot.data, metadata } : null;
}

function readCodexSelection(metadata: UnknownRecord): ConnectedServiceBindingSelection | null {
  const explicit = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  const bindings = explicit.success
    ? explicit.data
    : {
      v: 1,
      bindingsByServiceId: readSessionMetadataConnectedServiceBindings(metadata, 'codex'),
    };
  return parseConnectedServiceBindingSelections(bindings)
    .find((selection) => selection.serviceId === CODEX_CONNECTED_SERVICE_ID) ?? null;
}

function readCurrentGroupProfile(input: Readonly<{
  group: unknown;
  groupId: string;
}>): string | null {
  if (!isRecord(input.group)) return null;
  if (input.group.serviceId !== CODEX_CONNECTED_SERVICE_ID || input.group.groupId !== input.groupId) return null;
  const activeProfileId = canonicalText(input.group.activeProfileId);
  if (!activeProfileId || !Array.isArray(input.group.members)) return null;
  const isActiveMember = input.group.members.some((member) => (
    isRecord(member) && member.profileId === activeProfileId && member.enabled !== false
  ));
  return isActiveMember ? activeProfileId : null;
}

async function resolveCodexBinding(params: Readonly<{
  metadata: UnknownRecord;
  api: FusionProviderTelemetryHostApiV1;
}>): Promise<ResolvedCodexBindingV1 | null> {
  const selection = readCodexSelection(params.metadata);
  if (!selection) return null;
  if (selection.kind === 'profile') {
    const profileId = canonicalText(selection.profileId);
    return profileId ? { serviceId: CODEX_CONNECTED_SERVICE_ID, profileId } : null;
  }
  if (typeof params.api.getConnectedServiceAuthGroup !== 'function') return null;
  const group = await params.api.getConnectedServiceAuthGroup({
    serviceId: CODEX_CONNECTED_SERVICE_ID,
    groupId: selection.groupId,
  });
  const profileId = readCurrentGroupProfile({ group, groupId: selection.groupId });
  return profileId ? { serviceId: CODEX_CONNECTED_SERVICE_ID, profileId } : null;
}

async function readPersistedQuotaSnapshot(params: Readonly<{
  credentials: Credentials;
  api: FusionProviderTelemetryHostApiV1;
  accountMode: ConnectedServiceAccountMode;
  binding: ResolvedCodexBindingV1;
}>): Promise<PersistedQuotaSnapshotV1 | null> {
  const input = { serviceId: params.binding.serviceId, profileId: params.binding.profileId } as const;
  if (params.accountMode !== 'e2ee' && typeof params.api.getConnectedServiceQuotaSnapshotPlain === 'function') {
    const plain = params.accountMode === 'unknown'
      ? await params.api.getConnectedServiceQuotaSnapshotPlain(input).catch(() => null)
      : await params.api.getConnectedServiceQuotaSnapshotPlain(input);
    const parsed = parsePersistedPlainQuotaSnapshot(plain);
    if (parsed) return parsed;
    if (params.accountMode === 'plain') return null;
  }
  if (typeof params.api.getConnectedServiceQuotaSnapshotSealed !== 'function') return null;
  const sealed = await params.api.getConnectedServiceQuotaSnapshotSealed(input);
  return parsePersistedSealedQuotaSnapshot({ credentials: params.credentials, value: sealed });
}

function canonicalIsoTimestamp(value: unknown): string | null {
  const timestamp = readNonNegativeInteger(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.getTime() !== timestamp) return null;
  return date.toISOString();
}

type SnapshotAssessmentV1 =
  | Readonly<{ status: 'reported'; observedAt: string; expiresAt: string }>
  | Readonly<{ status: 'withheld'; reason: 'snapshot_unavailable' | 'snapshot_stale' | 'source_unavailable' }>;

function assessPersistedSnapshot(input: Readonly<{
  persisted: PersistedQuotaSnapshotV1;
  binding: ResolvedCodexBindingV1;
  nowMs: number;
}>): SnapshotAssessmentV1 {
  const nowMs = readNonNegativeInteger(input.nowMs);
  const { snapshot, metadata } = input.persisted;
  if (nowMs === null) return { status: 'withheld', reason: 'source_unavailable' };
  if (metadata.status !== 'ok') return { status: 'withheld', reason: 'snapshot_unavailable' };
  if (snapshot.serviceId !== input.binding.serviceId || snapshot.profileId !== input.binding.profileId) {
    return { status: 'withheld', reason: 'snapshot_unavailable' };
  }
  if (snapshot.fetchedAt !== metadata.fetchedAt || snapshot.staleAfterMs !== metadata.staleAfterMs) {
    return { status: 'withheld', reason: 'snapshot_unavailable' };
  }
  const expiresAtMs = snapshot.fetchedAt + snapshot.staleAfterMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= snapshot.fetchedAt || snapshot.fetchedAt > nowMs) {
    return { status: 'withheld', reason: 'snapshot_unavailable' };
  }
  const observedAt = canonicalIsoTimestamp(snapshot.fetchedAt);
  const expiresAt = canonicalIsoTimestamp(expiresAtMs);
  if (!observedAt || !expiresAt) return { status: 'withheld', reason: 'snapshot_unavailable' };
  if (nowMs >= expiresAtMs) return { status: 'withheld', reason: 'snapshot_stale' };
  return { status: 'reported', observedAt, expiresAt };
}

async function resolveSessionMetadataFromHappierHost(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
}>): Promise<ResolvedSessionMetadataV1 | null> {
  const context = await resolveExactSessionTransportContext({
    credentials: input.credentials,
    sessionId: input.sessionId,
  });
  if (!context.ok || context.sessionId !== input.sessionId) return null;
  const metadata = tryDecryptSessionMetadata({
    credentials: input.credentials,
    rawSession: context.rawSession,
  });
  return metadata ? { sessionId: context.sessionId, metadata } : null;
}

const defaultDependencies: FusionProviderTelemetryHostDependenciesV1 = {
  resolveSessionMetadata: resolveSessionMetadataFromHappierHost,
  createApi: async (credentials) => await ApiClient.create(credentials),
  resolveAccountMode: resolveConnectedServiceAccountMode,
  nowMs: () => Date.now(),
};

/**
 * FNXC:FusionProviderTelemetry 2026-07-21-03:37:
 * This opt-in local MCP extension reads only the persisted Codex quota snapshot
 * through Happier's host-safe storage APIs. The validated request sessionId is
 * authoritative and cannot be rewritten by a registration default or resolver.
 * It never refreshes a provider or invokes a Codex App Server path, and
 * intentionally returns no raw telemetry.
 */
export async function readFusionProviderTelemetryFromHappierHost(
  input: Readonly<{ credentials: Credentials; sessionId: string }>,
  overrides: Partial<FusionProviderTelemetryHostDependenciesV1> = {},
): Promise<FusionProviderTelemetryResultV1> {
  const sessionId = canonicalText(input.sessionId);
  if (!sessionId) return withheldResult('invalid_request');
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    const resolvedSession = await dependencies.resolveSessionMetadata({
      credentials: input.credentials,
      sessionId,
    });
    if (!resolvedSession || resolvedSession.sessionId !== sessionId) return withheldResult('session_unresolved');
    const api = await dependencies.createApi(input.credentials);
    const binding = await resolveCodexBinding({ metadata: resolvedSession.metadata, api });
    if (!binding) return withheldResult('binding_unavailable');
    const persisted = await readPersistedQuotaSnapshot({
      credentials: input.credentials,
      api,
      accountMode: await dependencies.resolveAccountMode(api),
      binding,
    });
    if (!persisted) return withheldResult('snapshot_unavailable');
    const assessment = assessPersistedSnapshot({ persisted, binding, nowMs: dependencies.nowMs() });
    return assessment.status === 'reported'
      ? freshSnapshotResult(assessment)
      : withheldResult(assessment.reason);
  } catch {
    return withheldResult('source_unavailable');
  }
}

export function isFusionProviderTelemetryExtensionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1 === '1';
}

export function registerFusionProviderTelemetryTool(params: Readonly<{
  server: McpToolRegistrar;
  credentials: Credentials;
  dependencies?: Partial<FusionProviderTelemetryHostDependenciesV1>;
  env?: NodeJS.ProcessEnv;
}>): readonly string[] {
  if (!isFusionProviderTelemetryExtensionEnabled(params.env)) return [];
  params.server.registerTool(
    FUSION_PROVIDER_TELEMETRY_TOOL_NAME,
    {
      title: 'Fusion Provider Telemetry',
      description: 'Local extension: report only whether a persisted Codex quota snapshot is present and verified fresh; capacity, concurrency, account, profile, model, and metrics are not reported.',
      inputSchema: fusionProviderTelemetryToolInputSchema,
    },
    async (args) => {
      const parsed = fusionProviderTelemetryToolInputSchema.safeParse(args);
      if (!parsed.success) {
        const result = withheldResult('invalid_request');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: false as const,
        };
      }
      const sessionId = canonicalText(parsed.data.sessionId);
      const result = sessionId
        ? await readFusionProviderTelemetryFromHappierHost(
          { credentials: params.credentials, sessionId },
          params.dependencies,
        )
        : withheldResult('invalid_request');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: false as const,
      };
    },
  );
  return [FUSION_PROVIDER_TELEMETRY_TOOL_NAME];
}
