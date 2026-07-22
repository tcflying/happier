import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export const FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME = 'fusion_runtime_snapshot_get';
export const FUSION_LOCAL_RUNTIME_SNAPSHOT_CONTRACT_VERSION = 1 as const;

const FUSION_LOCAL_RUNTIME_SNAPSHOT_TTL_MS = 30_000;
const SAFE_TEXT_MAX_LENGTH = 512;

export const fusionLocalRuntimeSnapshotToolInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(SAFE_TEXT_MAX_LENGTH).optional(),
}).strict();

type UnknownRecord = Record<string, unknown>;

export interface FusionLocalRuntimeSnapshotSessionResolutionV1 {
  readonly state: 'found' | 'session_not_found' | 'session_id_ambiguous' | 'unsupported';
  readonly sessionId?: string;
  readonly active?: unknown;
  readonly updatedAt?: unknown;
  readonly metadata?: UnknownRecord | null;
}

export interface FusionLocalRuntimeSnapshotDependenciesV1 {
  readonly resolveSession: (input: Readonly<{
    credentials: Credentials;
    sessionId: string;
  }>) => Promise<FusionLocalRuntimeSnapshotSessionResolutionV1>;
  readonly now: () => string;
}

export type FusionLocalRuntimeSnapshotResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly kind: 'fusion_local_runtime_snapshot';
    readonly contractVersion: typeof FUSION_LOCAL_RUNTIME_SNAPSHOT_CONTRACT_VERSION;
    readonly snapshot: Readonly<{
      readonly id: string;
      readonly revision: number;
      readonly capturedAt: string;
      readonly expiresAt: string;
    }>;
    readonly session: Readonly<{
      readonly id: string;
      readonly activity: 'active' | 'inactive' | 'unknown';
      readonly updatedAt: string | null;
    }>;
    readonly runtime: Readonly<{
      readonly modelState: 'known' | 'unknown';
      readonly providerId: string | null;
      readonly currentModelId: string | null;
      readonly modelObservedAt: string | null;
      readonly modelReason: 'acp_model_metadata_unavailable' | 'acp_model_metadata_invalid' | null;
    }>;
    /**
     * These are deliberately explicit so a downstream consumer cannot treat
     * this local ACP metadata extension as provider-account or quota proof.
     */
    readonly limitations: Readonly<{
      readonly providerAccount: 'not_reported';
      readonly providerQuota: 'not_reported';
      readonly latency: 'not_reported';
      readonly context: 'not_reported';
      readonly tools: 'not_reported';
      readonly quality: 'not_reported';
    }>;
    readonly provenance: Readonly<{
      readonly source: 'happier_local_acp_metadata';
      readonly transport: 'local_mcp_stdio';
      readonly sourceContractVersion: 1;
    }>;
  }>
  | Readonly<{
    readonly ok: false;
    readonly kind: 'fusion_local_runtime_snapshot';
    readonly errorCode: 'invalid_request' | 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'source_unavailable';
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

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const normalized = new Date(value).toISOString();
    return Number.isNaN(Date.parse(normalized)) ? null : normalized;
  }
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed).toISOString();
  return normalized === value ? normalized : null;
}

function snapshotRevision(...timestamps: readonly (string | null)[]): number {
  const latest = Math.max(0, ...timestamps.map((timestamp) => timestamp ? Date.parse(timestamp) : 0));
  return Number.isSafeInteger(latest) && latest > 0 ? latest : 1;
}

function snapshotId(input: Readonly<{
  sessionId: string;
  sessionUpdatedAt: string | null;
  providerId: string | null;
  currentModelId: string | null;
  modelObservedAt: string | null;
}>): string {
  const digest = createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
  return `happier-local-${digest}`;
}

function readAcpModelMetadata(metadata: UnknownRecord | null | undefined): Readonly<{
  providerId: string;
  currentModelId: string;
  observedAt: string;
}> | null {
  if (!metadata || !isRecord(metadata.acpSessionModelsV1)) return null;
  const entry = metadata.acpSessionModelsV1;
  if (entry.v !== 1) return null;
  const providerId = canonicalText(entry.provider);
  const currentModelId = canonicalText(entry.currentModelId);
  const observedAt = canonicalTimestamp(entry.updatedAt);
  if (!providerId || !currentModelId || !observedAt) return null;
  return { providerId, currentModelId, observedAt };
}

async function resolveHappierSession(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
}>): Promise<FusionLocalRuntimeSnapshotSessionResolutionV1> {
  const target = await resolveSessionTransportContext({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
  });
  if (!target.ok) {
    return { state: target.code };
  }
  return {
    state: 'found',
    sessionId: target.sessionId,
    active: target.rawSession.active,
    updatedAt: target.rawSession.updatedAt,
    metadata: tryDecryptSessionMetadata({
      credentials: input.credentials,
      rawSession: target.rawSession,
    }),
  };
}

const defaultDependencies: FusionLocalRuntimeSnapshotDependenciesV1 = {
  resolveSession: resolveHappierSession,
  now: () => new Date().toISOString(),
};

function unavailableResult(
  errorCode: Extract<FusionLocalRuntimeSnapshotResultV1, { readonly ok: false }>['errorCode'],
): FusionLocalRuntimeSnapshotResultV1 {
  return { ok: false, kind: 'fusion_local_runtime_snapshot', errorCode };
}

/**
 * FNXC:FusionLocalRuntimeSnapshot 2026-07-20-11:06:
 * This opt-in MCP extension exposes only the session-bound ACP model metadata
 * that Happier can decrypt locally. Its response names every omitted provider
 * fact explicitly, preventing Fusion from inferring account, quota, latency,
 * context, tools, or quality from a model label. It is intentionally not an
 * upstream/official MCP contract and is disabled unless the local host enables
 * HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1=1.
 */
export async function readFusionLocalRuntimeSnapshot(
  input: Readonly<{ credentials: Credentials; sessionId: string }>,
  overrides: Partial<FusionLocalRuntimeSnapshotDependenciesV1> = {},
): Promise<FusionLocalRuntimeSnapshotResultV1> {
  const sessionId = canonicalText(input.sessionId);
  if (!sessionId) return unavailableResult('invalid_request');
  const dependencies = { ...defaultDependencies, ...overrides };
  let session: FusionLocalRuntimeSnapshotSessionResolutionV1;
  try {
    session = await dependencies.resolveSession({ credentials: input.credentials, sessionId });
  } catch {
    return unavailableResult('source_unavailable');
  }
  if (session.state !== 'found') return unavailableResult(session.state);
  const resolvedSessionId = canonicalText(session.sessionId);
  if (!resolvedSessionId) return unavailableResult('source_unavailable');
  const capturedAt = canonicalTimestamp(dependencies.now());
  if (!capturedAt) return unavailableResult('source_unavailable');
  const sessionUpdatedAt = canonicalTimestamp(session.updatedAt);
  const modelMetadataPresent = Boolean(session.metadata && Object.prototype.hasOwnProperty.call(session.metadata, 'acpSessionModelsV1'));
  const model = readAcpModelMetadata(session.metadata);
  const expiresAt = new Date(Date.parse(capturedAt) + FUSION_LOCAL_RUNTIME_SNAPSHOT_TTL_MS).toISOString();
  const modelObservedAt = model?.observedAt ?? null;
  const providerId = model?.providerId ?? null;
  const currentModelId = model?.currentModelId ?? null;
  return {
    ok: true,
    kind: 'fusion_local_runtime_snapshot',
    contractVersion: FUSION_LOCAL_RUNTIME_SNAPSHOT_CONTRACT_VERSION,
    snapshot: {
      id: snapshotId({
        sessionId: resolvedSessionId,
        sessionUpdatedAt,
        providerId,
        currentModelId,
        modelObservedAt,
      }),
      revision: snapshotRevision(sessionUpdatedAt, modelObservedAt),
      capturedAt,
      expiresAt,
    },
    session: {
      id: resolvedSessionId,
      activity: session.active === true ? 'active' : session.active === false ? 'inactive' : 'unknown',
      updatedAt: sessionUpdatedAt,
    },
    runtime: {
      modelState: model ? 'known' : 'unknown',
      providerId,
      currentModelId,
      modelObservedAt,
      modelReason: model ? null : modelMetadataPresent ? 'acp_model_metadata_invalid' : 'acp_model_metadata_unavailable',
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
      sourceContractVersion: 1,
    },
  };
}

export function isFusionLocalRuntimeSnapshotExtensionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1 === '1';
}

export function registerFusionLocalRuntimeSnapshotTool(params: Readonly<{
  server: McpToolRegistrar;
  credentials: Credentials;
  resolveSessionId: (args: unknown) => string | null;
  dependencies?: Partial<FusionLocalRuntimeSnapshotDependenciesV1>;
  env?: NodeJS.ProcessEnv;
}>): readonly string[] {
  if (!isFusionLocalRuntimeSnapshotExtensionEnabled(params.env)) return [];
  params.server.registerTool(
    FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME,
    {
      title: 'Fusion Local Runtime Snapshot',
      description: 'Local extension: report only session-bound ACP model metadata; account, quota, latency, context, tools, and quality remain unverified.',
      inputSchema: fusionLocalRuntimeSnapshotToolInputSchema,
    },
    async (args) => {
      const parsed = fusionLocalRuntimeSnapshotToolInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(unavailableResult('invalid_request')) }],
          isError: true as const,
        };
      }
      const sessionId = params.resolveSessionId(parsed.data);
      const result = sessionId
        ? await readFusionLocalRuntimeSnapshot({ credentials: params.credentials, sessionId }, params.dependencies)
        : unavailableResult('invalid_request');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );
  return [FUSION_LOCAL_RUNTIME_SNAPSHOT_TOOL_NAME];
}
