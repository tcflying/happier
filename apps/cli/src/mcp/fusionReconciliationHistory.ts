import { z } from 'zod';

import type { Credentials } from '@/persistence';
import {
  fetchEncryptedTranscriptMessagesPage,
  type FetchEncryptedTranscriptMessagesPageResult,
  type RawTranscriptRow,
} from '@/session/replay/fetchEncryptedTranscriptMessages';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryResolveDecryptedTranscriptPayload } from '@/session/services/transcript/transcriptHistoryRows';

export const FUSION_RECONCILIATION_HISTORY_TOOL_NAME = 'fusion_reconciliation_history_get';
export const FUSION_RECONCILIATION_HISTORY_CONTRACT_VERSION = 1 as const;

const MAX_ID_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_PAGE_LIMIT = 250;
const DEFAULT_PAGE_LIMIT = 100;

export const fusionReconciliationHistoryToolInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(MAX_ID_LENGTH).optional(),
  afterCursor: z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/u).nullable().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
}).strict();

type UnknownRecord = Record<string, unknown>;
type DecryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;
type ReconciliationErrorCode = 'invalid_request' | 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'source_unavailable';

export interface FusionReconciliationHistorySessionResolutionV1 {
  readonly state: 'found' | 'session_not_found' | 'session_id_ambiguous' | 'unsupported';
  readonly sessionId?: string;
  readonly ctx?: DecryptionContext;
}

export interface FusionReconciliationHistoryDependenciesV1 {
  readonly resolveSession: (input: Readonly<{
    credentials: Credentials;
    sessionId: string;
  }>) => Promise<FusionReconciliationHistorySessionResolutionV1>;
  readonly fetchPage: (input: Readonly<{
    credentials: Credentials;
    sessionId: string;
    afterSeq: number;
    limit: number;
  }>) => Promise<FetchEncryptedTranscriptMessagesPageResult>;
  readonly decryptPayload: (input: Readonly<{
    content: unknown;
    ctx: DecryptionContext;
  }>) => unknown | null;
}

export type FusionReconciliationHistoryResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly kind: 'fusion_reconciliation_history';
    readonly contractVersion: typeof FUSION_RECONCILIATION_HISTORY_CONTRACT_VERSION;
    readonly session: Readonly<{ readonly id: string }>;
    readonly page: Readonly<{
      readonly afterCursor: string | null;
      readonly completeThroughCursor: string | null;
      readonly nextCursor: string | null;
      readonly truncated: boolean;
    }>;
    readonly items: readonly Readonly<{
      readonly nativeMessageId: string;
      readonly localMessageId: string;
      readonly content: string;
      readonly occurredAtMs: number;
      readonly cursor: string;
    }>[];
    readonly provenance: Readonly<{
      readonly source: 'happier_local_encrypted_transcript';
      readonly transport: 'local_mcp_stdio';
      readonly sourceContractVersion: 1;
    }>;
  }>
  | Readonly<{
    readonly ok: false;
    readonly kind: 'fusion_reconciliation_history';
    readonly errorCode: ReconciliationErrorCode;
  }>;

type McpToolRegistrar = Readonly<{
  registerTool: (name: string, meta: unknown, handler: (args: unknown) => Promise<unknown>) => void;
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function canonicalOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (!value || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function parseCursor(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function canonicalSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function extractUserText(value: unknown): string | null {
  if (!isRecord(value) || value.role !== 'user' || !isRecord(value.content)) return null;
  if (value.content.type !== 'text' || typeof value.content.text !== 'string') return null;
  const text = value.content.text;
  if (!text || text.length > MAX_MESSAGE_LENGTH || text.includes('\u0000')) return null;
  return text;
}

function safeSessionState(value: unknown): Exclude<FusionReconciliationHistorySessionResolutionV1['state'], 'found'> {
  return value === 'session_not_found' || value === 'session_id_ambiguous' ? value : 'unsupported';
}

async function resolveHappierSession(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
}>): Promise<FusionReconciliationHistorySessionResolutionV1> {
  const target = await resolveSessionTransportContext({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
  });
  if (!target.ok) return { state: safeSessionState(target.code) };
  return {
    state: 'found',
    sessionId: target.sessionId,
    ctx: target.ctx,
  };
}

const defaultDependencies: FusionReconciliationHistoryDependenciesV1 = {
  resolveSession: resolveHappierSession,
  fetchPage: async ({ credentials, sessionId, afterSeq, limit }) => await fetchEncryptedTranscriptMessagesPage({
    token: credentials.token,
    sessionId,
    afterSeq,
    limit,
    scope: 'all',
  }),
  decryptPayload: ({ content, ctx }) => tryResolveDecryptedTranscriptPayload({ content, ctx }),
};

function unavailableResult(errorCode: ReconciliationErrorCode): FusionReconciliationHistoryResultV1 {
  return { ok: false, kind: 'fusion_reconciliation_history', errorCode };
}

function pageCoverageCursor(afterCursor: string | null, maximumSequence: number): string | null {
  if (maximumSequence > 0) return String(maximumSequence);
  return afterCursor;
}

/**
 * FNXC:FusionReconciliationHistory 2026-07-20-11:50:
 * This opt-in, local-only MCP extension reads the existing encrypted Happier
 * transcript endpoint in its native afterSeq order and preserves its durable
 * localId plus server sequence. Fusion uses it solely for fail-closed outbox
 * reconciliation; malformed rows, duplicate/stalled cursors, or an absent
 * explicit flag never become delivery confirmation. It is not an upstream
 * public MCP capability and remains disabled by default.
 */
export async function readFusionReconciliationHistory(
  input: Readonly<{
    credentials: Credentials;
    sessionId: string;
    afterCursor: string | null;
    limit: number;
  }>,
  overrides: Partial<FusionReconciliationHistoryDependenciesV1> = {},
): Promise<FusionReconciliationHistoryResultV1> {
  const sessionId = canonicalRequestId(input.sessionId);
  const afterSequence = parseCursor(input.afterCursor);
  if (!sessionId || afterSequence === null || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_LIMIT) {
    return unavailableResult('invalid_request');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  let session: FusionReconciliationHistorySessionResolutionV1;
  try {
    session = await dependencies.resolveSession({ credentials: input.credentials, sessionId });
  } catch {
    return unavailableResult('source_unavailable');
  }
  if (session.state !== 'found') return unavailableResult(session.state);
  const resolvedSessionId = canonicalOpaqueId(session.sessionId);
  if (!resolvedSessionId || !session.ctx) return unavailableResult('source_unavailable');

  let sourcePage: FetchEncryptedTranscriptMessagesPageResult;
  try {
    sourcePage = await dependencies.fetchPage({
      credentials: input.credentials,
      sessionId: resolvedSessionId,
      afterSeq: afterSequence,
      limit: input.limit,
    });
  } catch {
    return unavailableResult('source_unavailable');
  }
  if (!Array.isArray(sourcePage.messages) || typeof sourcePage.hasMore !== 'boolean') {
    return unavailableResult('source_unavailable');
  }

  const rows: readonly RawTranscriptRow[] = sourcePage.messages;
  const observedSequences = new Set<number>();
  let maximumSequence = afterSequence;
  const items: Array<Extract<FusionReconciliationHistoryResultV1, { readonly ok: true }>['items'][number]> = [];
  for (const row of rows) {
    const sequence = canonicalSequence(row.seq);
    if (sequence === null || sequence <= afterSequence || observedSequences.has(sequence)) {
      return unavailableResult('source_unavailable');
    }
    observedSequences.add(sequence);
    maximumSequence = Math.max(maximumSequence, sequence);
    if (typeof row.messageRole === 'string' && row.messageRole !== 'user') continue;
    const nativeMessageId = canonicalOpaqueId(row.id);
    const localMessageId = canonicalOpaqueId(row.localId);
    const occurredAtMs = canonicalTimestamp(row.createdAt);
    if (!nativeMessageId || !localMessageId || occurredAtMs === null) continue;
    const content = extractUserText(dependencies.decryptPayload({ content: row.content, ctx: session.ctx }));
    if (!content) continue;
    items.push({
      nativeMessageId,
      localMessageId,
      content,
      occurredAtMs,
      cursor: String(sequence),
    });
  }
  items.sort((left, right) => Number(left.cursor) - Number(right.cursor));

  if (sourcePage.hasMore) {
    const nextAfterSequence = canonicalSequence(sourcePage.nextAfterSeq);
    if (rows.length === 0 || nextAfterSequence === null || nextAfterSequence !== maximumSequence) {
      return unavailableResult('source_unavailable');
    }
  }

  return {
    ok: true,
    kind: 'fusion_reconciliation_history',
    contractVersion: FUSION_RECONCILIATION_HISTORY_CONTRACT_VERSION,
    session: { id: resolvedSessionId },
    page: {
      afterCursor: input.afterCursor,
      completeThroughCursor: pageCoverageCursor(input.afterCursor, maximumSequence),
      nextCursor: sourcePage.hasMore ? String(maximumSequence) : null,
      truncated: sourcePage.hasMore,
    },
    items,
    provenance: {
      source: 'happier_local_encrypted_transcript',
      transport: 'local_mcp_stdio',
      sourceContractVersion: 1,
    },
  };
}

export function isFusionReconciliationHistoryExtensionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1 === '1';
}

export function registerFusionReconciliationHistoryTool(params: Readonly<{
  server: McpToolRegistrar;
  credentials: Credentials;
  resolveSessionId: (args: unknown) => string | null;
  dependencies?: Partial<FusionReconciliationHistoryDependenciesV1>;
  env?: NodeJS.ProcessEnv;
}>): readonly string[] {
  if (!isFusionReconciliationHistoryExtensionEnabled(params.env)) return [];
  params.server.registerTool(
    FUSION_RECONCILIATION_HISTORY_TOOL_NAME,
    {
      title: 'Fusion Reconciliation History',
      description: 'Local extension: return exact session user-message localIds with server-sequence paging for fail-closed Fusion outbox reconciliation.',
      inputSchema: fusionReconciliationHistoryToolInputSchema,
    },
    async (args) => {
      const parsed = fusionReconciliationHistoryToolInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(unavailableResult('invalid_request')) }],
          isError: true as const,
        };
      }
      const sessionId = params.resolveSessionId(parsed.data);
      const result = sessionId
        ? await readFusionReconciliationHistory({
          credentials: params.credentials,
          sessionId,
          afterCursor: parsed.data.afterCursor ?? null,
          limit: parsed.data.limit ?? DEFAULT_PAGE_LIMIT,
        }, params.dependencies)
        : unavailableResult('invalid_request');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );
  return [FUSION_RECONCILIATION_HISTORY_TOOL_NAME];
}
