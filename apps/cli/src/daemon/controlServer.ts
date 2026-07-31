/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { resolveCatalogAgentIdForCliSubcommand } from '@/backends/catalog';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CodexChatGptAuthTokensRefreshResponseSchema,
  CodexChatGptAuthTokensRefreshSelectionSchema,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';
import { TrackedSession } from './types';
import { SPAWN_SESSION_ERROR_CODES, SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import {
  mergeSpawnSessionOptions,
  normalizeSpawnSessionDirectory,
  SpawnDaemonSessionRequestSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import {
  ConnectedServiceIdSchema,
  ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
  type SessionConnectedServiceAuthSwitchRpcParams,
} from '@happier-dev/protocol';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeFailureClassification,
} from './connectedServices/runtimeAuth/types';
import { isTemporaryRetryOwnedConnectedServiceRuntimeFailure } from './connectedServices/runtimeAuth/ConnectedServiceRecoveryPolicy';
import { resolveRuntimeAuthRecoveryDurableWaitPlan } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import {
  isProvenRuntimeAuthRecoverySuccess,
  resolveRuntimeAuthRecoveryProof,
  type RuntimeAuthRecoveryProofKind,
} from './connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryOutcome';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/diagnostics/sanitizeConnectedServiceDiagnosticString';
import {
  buildRuntimeAuthRecoveryScheduledResult,
  buildRuntimeAuthRecoveryTerminalResult,
} from './connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import type { OldSessionRunnerMigrationResult } from './processSupervision/migrateOldSessionRunners';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';
const DEFAULT_SPAWN_NONCE_PENDING_TTL_MS = 5 * 60_000;
const DEFAULT_SPAWN_NONCE_SUCCESS_TTL_MS = 60 * 60_000;
const SPAWN_NONCE_PENDING_TTL_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_NONCE_PENDING_TTL_MS';
const SPAWN_NONCE_SUCCESS_TTL_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_NONCE_SUCCESS_TTL_MS';
const DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH = 500;

function readSafeDaemonControlErrorDiagnostic(error: unknown): Readonly<{
  name: string;
  message: string;
}> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: sanitizeConnectedServiceDiagnosticString(error.message, { maxLength: DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH }),
    };
  }
  return {
    name: typeof error,
    message: sanitizeConnectedServiceDiagnosticString(String(error), { maxLength: DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH }),
  };
}

type RuntimeAuthRecoverySchedulerForControlServer = Readonly<{
  beginClassifiedFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<unknown>;
  enqueueHandlerFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
  }>) => Promise<unknown>;
  enqueueApplyFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
  }>) => Promise<unknown>;
  cancel?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>;
  cancelByKey?: (recoveryKey: string) => Promise<unknown>;
  markTerminalByKey?: (input: Readonly<{ recoveryKey: string; terminalReason: string }>) => Promise<unknown>;
  markDurableWaitForResultByKey?: (input: Readonly<{
    recoveryKey: string;
    result: unknown;
    classificationResetsAtMs: number | null;
  }>) => Promise<unknown>;
  markAwaitingProviderOutcomeProofForResultByKey?: (input: Readonly<{
    recoveryKey: string;
    result: unknown;
  }>) => Promise<unknown>;
  markProviderOutcomeProofByKey?: (input: Readonly<{
    recoveryKey: string;
    proofKind: RuntimeAuthRecoveryProofKind;
  }>) => Promise<unknown>;
  markSucceededByKey?: (recoveryKey: string) => Promise<unknown>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readRuntimeAuthSwitchResult(result: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result)) return null;
  if (result.status === 'switch_attempted' && isRecord(result.result)) return result.result;
  return result;
}

// Only deterministic recovered provider-outcome proof clears the recovery intent
// here. A bare switch /
// observed_generation / credential_refreshed / generic ok:true is a local phase,
// not proof the provider can authenticate; clearing on those produced the live
// "recovery cleared while session still broken" loop. See
// resolveRuntimeAuthRecoveryOutcome.
function resolveRuntimeAuthSwitchSuccessProof(result: unknown): RuntimeAuthRecoveryProofKind | null {
  if (!isProvenRuntimeAuthRecoverySuccess(result)) return null;
  return resolveRuntimeAuthRecoveryProof(result);
}

function isScheduledRuntimeAuthRecovery(result: unknown): boolean {
  return isRecord(result) && result.status === 'scheduled' && result.retryable === true;
}

function isTerminalRuntimeAuthRecovery(result: unknown): boolean {
  return isRecord(result) && (
    result.status === 'exhausted'
    || result.status === 'cancelled'
    || result.status === 'terminal'
    || result.status === 'terminal_non_retry'
  );
}

function isRuntimeAuthApplyFailureResult(result: unknown): boolean {
  return readRuntimeAuthSwitchResult(result)?.status === 'generation_apply_failed';
}

// Mirror of the scheduler-retry terminal classification for the in-band report
// path. `switch_limit_reached`, group-exhausted `no_eligible_member`, and non-group
// waitable `recovery_action_required` results with a computable reset are NOT here:
// those are durable waits (resolveRuntimeAuthRecoveryDurableWaitPlan, F0 / INC-2 /
// FIX-4) and the durable-wait gate runs BEFORE this terminal classification, so this
// only sees recovery_action_required results without a computable wait-until.
// Terminalizing waits cancelled the just-intaken intent, whose terminal record then
// blocked re-arming the same key until the 7-day prune (RD-REC-13).
function readRuntimeAuthTerminalReason(result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (result.status === 'recovery_action_required') return 'recovery_action_required';
  const switchResult = readRuntimeAuthSwitchResult(result);
  if (!switchResult || typeof switchResult.status !== 'string') return null;
  if (switchResult.status === 'recovery_action_required') return switchResult.status;
  // A non-group-exhausted `no_eligible_member` has no wait signal and no member to
  // wait for — terminal, exactly as the scheduler-retry path classifies it.
  if (switchResult.status === 'no_eligible_member' && switchResult.groupExhausted !== true) {
    return switchResult.status;
  }
  return null;
}

async function beginRuntimeAuthRecoveryIntake(input: Readonly<{
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  sessionId: string;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>> {
  if (!input.runtimeAuthRecoveryScheduler?.beginClassifiedFailure) return { ok: true };
  try {
    await input.runtimeAuthRecoveryScheduler.beginClassifiedFailure({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return !/^PID-\d+$/.test(normalized);
}

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
}

function resolveDaemonControlBodyLimitBytes(): number {
  const raw = String(process.env[DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;
  }

  return Math.max(1024 * 1024, Math.min(parsed, 64 * 1024 * 1024));
}

function resolvePositiveIntFromEnv(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

type SpawnNonceCorrelationRecord = Readonly<{
  status: 'pending' | 'success';
  sessionId?: string;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

type SpawnNonceAdmissionResult =
  | { type: 'none' }
  | { type: 'claimed' }
  | { type: 'pending' }
  | { type: 'success'; sessionId: string };

export function createDaemonControlApp({
  getChildren,
  machineId,
  stopSession,
  prepareStopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  handleConnectedServiceRuntimeAuthFailure,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleSessionConnectedServiceAuthSwitch,
  handleConnectedServiceQuotaSnapshot,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleCodexChatGptAuthTokensRefresh,
  handleMigrateOldSessionRunners,
  handleCodexDirectSessionLinkEnsure,
  runtimeAuthRecoveryScheduler,
  isShuttingDown,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  prepareStopSession?: (child: TrackedSession) => Promise<void> | void;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>) => Promise<unknown>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  // Daemon-lifecycle guard. When the daemon is shutting down (or the control server is
  // stopping), runtime-auth recovery handlers MUST NOT run switch/restart/continuation:
  // post-shutdown work can never reach provider-outcome proof and races a dying endpoint.
  isShuttingDown?: () => boolean;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
  }>) => Promise<unknown>;
  // QAE-1: user "Stop waiting" propagation — cancels the daemon-side durable
  // recovery wait state (runtime-auth recovery + inactive usage-limit stores).
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<SessionConnectedServiceAuthSwitchRpcParams>) => Promise<unknown>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>) => Promise<unknown>;
  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
  handleMigrateOldSessionRunners?: () => Promise<OldSessionRunnerMigrationResult>;
  handleCodexDirectSessionLinkEnsure?: (input: Readonly<{
    remoteSessionId: string;
    title: string;
    directory?: string;
  }>) => Promise<Readonly<{
    ok: boolean;
    sessionId?: string;
    created?: boolean;
    errorCode?: string;
    errorMessage?: string;
  }>>;
}): FastifyInstance {
  void machineId;
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }

  const app = fastify({
    logger: false, // We use our own logger
    bodyLimit: resolveDaemonControlBodyLimitBytes(),
  });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const spawnNoncePendingTtlMs = resolvePositiveIntFromEnv(
    SPAWN_NONCE_PENDING_TTL_ENV_KEY,
    DEFAULT_SPAWN_NONCE_PENDING_TTL_MS,
  );
  const spawnNonceSuccessTtlMs = resolvePositiveIntFromEnv(
    SPAWN_NONCE_SUCCESS_TTL_ENV_KEY,
    DEFAULT_SPAWN_NONCE_SUCCESS_TTL_MS,
  );
  const spawnNonceCorrelationByNonce = new Map<string, SpawnNonceCorrelationRecord>();

  const pruneSpawnNonceCorrelation = (nowMs: number = Date.now()): void => {
    for (const [spawnNonce, record] of spawnNonceCorrelationByNonce.entries()) {
      if (record.expiresAtMs <= nowMs) {
        spawnNonceCorrelationByNonce.delete(spawnNonce);
      }
    }
  };

  const markSpawnNoncePending = (spawnNonce: string): void => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (current?.status === 'success' && current.expiresAtMs > nowMs) return;
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'pending',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNoncePendingTtlMs,
    });
  };

  const markSpawnNonceSuccess = (spawnNonce: string, sessionId: string): void => {
    const normalizedNonce = spawnNonce.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedNonce || !isCanonicalSessionId(normalizedSessionId)) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'success',
      sessionId: normalizedSessionId,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNonceSuccessTtlMs,
    });
  };

  const claimSpawnNonceAdmission = (spawnNonce: string): SpawnNonceAdmissionResult => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return { type: 'none' };
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    // This map is daemon-process local. Happier's daemon currently serves one user,
    // so the nonce itself is the admission key; a future multi-tenant daemon must
    // include the authenticated account/user scope in this key.
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (current?.status === 'success' && isCanonicalSessionId(current.sessionId)) {
      return { type: 'success', sessionId: current.sessionId.trim() };
    }
    if (current?.status === 'pending') {
      return { type: 'pending' };
    }
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'pending',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNoncePendingTtlMs,
    });
    return { type: 'claimed' };
  };

  const markSpawnNonceFromTrackedSession = (sessionId: string): void => {
    const normalizedSessionId = sessionId.trim();
    if (!isCanonicalSessionId(normalizedSessionId)) return;
    for (const child of getChildren()) {
      const trackedNonce = typeof child.spawnOptions?.spawnNonce === 'string'
        ? child.spawnOptions.spawnNonce.trim()
        : '';
      const trackedSessionId = typeof child.happySessionId === 'string'
        ? child.happySessionId.trim()
        : '';
      if (!trackedNonce || trackedSessionId !== normalizedSessionId) continue;
      markSpawnNonceSuccess(trackedNonce, trackedSessionId);
    }
  };

  const authSchema401 = z.object({
    success: z.literal(false),
    error: z.string(),
  });

  const requireAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!provided || !safeTokenEquals(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };

  typed.post('/ping', {
    schema: {
      response: {
        200: z.object({ status: z.literal('ok') }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    return { status: 'ok' as const };
  });

  typed.post('/codex/direct-session-link', {
    schema: {
      body: z.object({
        remoteSessionId: z.string().trim().min(1).max(256),
        title: z.string().trim().min(1).max(512),
        directory: z.string().trim().min(1).max(32_768).optional(),
      }),
      response: {
        200: z.object({
          ok: z.boolean(),
          sessionId: z.string().optional(),
          created: z.boolean().optional(),
          errorCode: z.string().optional(),
          errorMessage: z.string().optional(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('codex_direct_session_link_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleCodexDirectSessionLinkEnsure) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'codex_direct_session_link_handler_unavailable' as const,
      };
    }
    return await handleCodexDirectSessionLinkEnsure({
      remoteSessionId: request.body.remoteSessionId,
      title: request.body.title,
      ...(request.body.directory ? { directory: request.body.directory } : {}),
    });
  });

  typed.post('/connected-service-auth/session/switch', {
    schema: {
      body: SessionConnectedServiceAuthSwitchRpcParamsSchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_auth_switch_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionConnectedServiceAuthSwitch) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_auth_switch_handler_unavailable' as const,
      };
    }
    const result = await handleSessionConnectedServiceAuthSwitch(request.body);
    return { ok: true as const, result };
  });

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: z.object({
        sessionId: z.string(),
        metadata: z.any() // Metadata type from API
      }),
      response: {
        200: z.object({
          status: z.literal('ok')
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId, metadata } = request.body;

    logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
    onHappySessionWebhook(sessionId, metadata);
    markSpawnNonceFromTrackedSession(sessionId);

    return { status: 'ok' as const };
  });

  typed.post('/connected-service-runtime-auth/failure', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        switchesThisTurn: z.number().int().nonnegative().optional(),
        resumePromptMode: z.enum(['standard', 'off', 'custom']).optional(),
        classification: z.object({
          kind: ConnectedServiceRuntimeAuthFailureKindSchema,
          serviceId: z.string().min(1),
          profileId: z.string().nullable(),
          groupId: z.string().nullable(),
          resetsAtMs: z.number().nullable(),
          planType: z.string().nullable(),
          rateLimits: z.unknown().nullable(),
          source: z.enum(['structured_provider_error', 'stable_provider_message', 'provider_runtime_marker']),
        }).passthrough(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_handler_unavailable'),
        }),
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_recovery_intake_failed'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceRuntimeAuthFailure) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_handler_unavailable' as const,
      };
    }
    const startedAtMs = Date.now();
    const sessionId = request.body.sessionId;
    const switchesThisTurn = request.body.switchesThisTurn ?? 0;
    const resumePromptMode = request.body.resumePromptMode;
    const classification = request.body.classification as ConnectedServiceRuntimeFailureClassification;
    // Daemon-lifecycle guard: if the daemon is shutting down, do NOT run the
    // recovery handler and do NOT create a new durable recovery intent from this
    // in-band report. Already-persisted intents remain owned by the scheduler and
    // can be re-driven by a healthy future daemon.
    if (isShuttingDown?.() === true) {
      return {
        ok: true as const,
        result: {
          status: 'daemon_lifecycle_unavailable' as const,
          reason: 'recovery_deferred_shutdown' as const,
        },
      };
    }
    if (!isTemporaryRetryOwnedConnectedServiceRuntimeFailure(classification)) {
      const intake = await beginRuntimeAuthRecoveryIntake({
        runtimeAuthRecoveryScheduler,
        sessionId,
        switchesThisTurn,
        classification,
      });
      if (!intake.ok) {
        const diagnostic = readSafeDaemonControlErrorDiagnostic(intake.error);
        logger.warn('[CONTROL SERVER] Connected-service runtime auth recovery intake failed', {
          ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
            sessionId,
            classification,
            handlerFailure: {
              errorCode: 'runtime_auth_recovery_intake_failed',
              errorName: diagnostic.name,
              errorMessage: diagnostic.message,
            },
            routedThroughFsm: false,
            startedAtMs,
            finishedAtMs: Date.now(),
          }),
          kind: classification.kind,
          error: diagnostic,
        });
        reply.code(503);
        return {
          ok: false as const,
          errorCode: 'connected_service_runtime_auth_recovery_intake_failed' as const,
        };
      }
    }
    try {
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        classification,
        ...(resumePromptMode ? { resumePromptMode } : {}),
      });
      if (isRuntimeAuthApplyFailureResult(result) && runtimeAuthRecoveryScheduler?.enqueueApplyFailure) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueApplyFailure({
            sessionId,
            switchesThisTurn,
            classification,
            result,
          });
          if (isScheduledRuntimeAuthRecovery(recovery)) {
            return {
              ok: true as const,
              result: buildRuntimeAuthRecoveryScheduledResult({
                classification,
                recovery,
                originalResult: result,
              }),
            };
          }
          if (isTerminalRuntimeAuthRecovery(recovery)) {
            return {
              ok: true as const,
              result: buildRuntimeAuthRecoveryTerminalResult({
                classification,
                recovery,
                originalResult: result,
              }),
            };
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      const recoveredProofKind = resolveRuntimeAuthSwitchSuccessProof(result);
      if (recoveredProofKind) {
        const recoveryKey = buildRuntimeAuthRecoveryKey({
          sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId,
          groupId: classification.groupId,
        });
        const resolveRecoveryProof = async (): Promise<unknown> => {
          if (runtimeAuthRecoveryScheduler?.markProviderOutcomeProofByKey) {
            return await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByKey({
              recoveryKey,
              proofKind: recoveredProofKind,
            });
          }
          if (runtimeAuthRecoveryScheduler?.markSucceededByKey) {
            return await runtimeAuthRecoveryScheduler.markSucceededByKey(recoveryKey);
          }
          if (runtimeAuthRecoveryScheduler?.cancelByKey) {
            return await runtimeAuthRecoveryScheduler.cancelByKey(recoveryKey);
          }
          return undefined;
        };
        await resolveRecoveryProof().catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof resolution failed after success', {
            sessionId,
            recoveryKey,
            proofKind: recoveredProofKind,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId,
        serviceId: classification.serviceId,
        profileId: classification.profileId,
        groupId: classification.groupId,
      });
      await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofForResultByKey?.({
        recoveryKey,
        result,
      }).catch((error) => {
        logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof-wait mark failed after local recovery result', {
          sessionId,
          recoveryKey,
          error: readSafeDaemonControlErrorDiagnostic(error),
        });
      });
      // F0/INC-2 (in-band path): group-exhausted and switch-limited results are
      // durable waits — re-arm the just-intaken intent at the computed/floored
      // wake time instead of terminalizing it. The classification gate runs here
      // (so the terminal branch below never sees a durable-wait result even when
      // the scheduler double lacks the re-arm method); the wake TIME is resolved
      // by the scheduler on its own clock.
      const durableWait = resolveRuntimeAuthRecoveryDurableWaitPlan({
        result,
        classificationResetsAtMs: classification.resetsAtMs ?? null,
        nowMs: Date.now(),
      });
      if (durableWait) {
        await runtimeAuthRecoveryScheduler?.markDurableWaitForResultByKey?.({
          recoveryKey,
          result,
          classificationResetsAtMs: classification.resetsAtMs ?? null,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery durable-wait re-arm failed after group-exhausted result', {
            sessionId,
            recoveryKey,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
        return { ok: true as const, result };
      }
      const terminalReason = readRuntimeAuthTerminalReason(result);
      if (terminalReason) {
        await runtimeAuthRecoveryScheduler?.markTerminalByKey?.({
          recoveryKey,
          terminalReason,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery terminalization failed after terminal result', {
            sessionId,
            recoveryKey,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      return { ok: true as const, result };
    } catch (error) {
      const diagnostic = readSafeDaemonControlErrorDiagnostic(error);
      logger.warn('[CONTROL SERVER] Connected-service runtime auth failure handler failed', {
        ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
          sessionId,
          classification,
          handlerFailure: {
            errorCode: 'unexpected_error',
            errorName: diagnostic.name,
            errorMessage: diagnostic.message,
          },
          routedThroughFsm: false,
          startedAtMs,
          finishedAtMs: Date.now(),
        }),
        kind: classification.kind,
        error: diagnostic,
      });
      if (runtimeAuthRecoveryScheduler?.enqueueHandlerFailure) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
            sessionId,
            switchesThisTurn,
            classification,
            error,
          });
          if (isScheduledRuntimeAuthRecovery(recovery)) {
            return {
              ok: true as const,
              result: buildRuntimeAuthRecoveryScheduledResult({
                classification,
                recovery,
              }),
            };
          }
          if (isTerminalRuntimeAuthRecovery(recovery)) {
            return {
              ok: true as const,
              result: buildRuntimeAuthRecoveryTerminalResult({
                classification,
                recovery,
              }),
            };
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      return {
        ok: true as const,
        result: {
          status: 'recovery_handler_failed' as const,
          errorCode: 'unexpected_error' as const,
        },
      };
    }
  });

  typed.post('/connected-service-turn-lifecycle', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        event: z.enum(['prompt_or_steer', 'task_started', 'assistant_message_end', 'turn_cancelled']),
        // REV-1: failTurn emits assistant_message_end too; the status lets the daemon
        // distinguish failed turns from genuinely completed ones.
        terminalStatus: z.enum(['completed', 'failed']).optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_turn_lifecycle_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceTurnLifecycle) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_turn_lifecycle_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceTurnLifecycle({
      sessionId: request.body.sessionId,
      event: request.body.event,
      ...(request.body.terminalStatus ? { terminalStatus: request.body.terminalStatus } : {}),
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-usage-limit/wait-resume-cancel', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_usage_limit_wait_resume_cancel_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceUsageLimitWaitResumeCancel) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_usage_limit_wait_resume_cancel_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceUsageLimitWaitResumeCancel({
      sessionId: request.body.sessionId,
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-quota-snapshot', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        serviceId: ConnectedServiceIdSchema,
        snapshot: ConnectedServiceQuotaSnapshotV1Schema,
      }).superRefine((body, ctx) => {
        if (body.snapshot.serviceId !== body.serviceId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'snapshot serviceId must match request serviceId',
            path: ['snapshot', 'serviceId'],
          });
        }
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_snapshot_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isShuttingDown?.() === true) {
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'daemon_shutting_down' as const,
      };
    }
    if (!handleConnectedServiceQuotaSnapshot) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_snapshot_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceQuotaSnapshot({
      sessionId: request.body.sessionId,
      serviceId: request.body.serviceId,
      snapshot: request.body.snapshot,
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-quota-recovery-credit/consume', {
    schema: {
      body: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_recovery_credit_consume_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isShuttingDown?.() === true) {
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'daemon_shutting_down' as const,
      };
    }
    if (!handleConnectedServiceQuotaRecoveryCreditConsume) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_recovery_credit_consume_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceQuotaRecoveryCreditConsume({
      serviceId: request.body.serviceId,
      profileId: request.body.profileId,
      idempotencyKey: request.body.idempotencyKey,
      ...(request.body.providerCreditId ? { providerCreditId: request.body.providerCreditId } : {}),
    });
    return { ok: true as const, result };
  });

  typed.post(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH, {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        selection: CodexChatGptAuthTokensRefreshSelectionSchema,
        chatgptPlanType: z.string().nullable().optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: CodexChatGptAuthTokensRefreshResponseSchema,
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_chatgpt_refresh_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleCodexChatGptAuthTokensRefresh) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_chatgpt_refresh_handler_unavailable' as const,
      };
    }
    const result = await handleCodexChatGptAuthTokensRefresh({
      sessionId: request.body.sessionId,
      selection: request.body.selection,
      chatgptPlanType: request.body.chatgptPlanType ?? null,
    });
    return { ok: true as const, result };
  });

  // List all tracked sessions
  typed.post('/list', {
    schema: {
      response: {
        200: z.object({
          children: z.array(z.object({
            startedBy: z.string(),
            happySessionId: z.string(),
            pid: z.number()
          }))
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const children = getChildren();
    logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
    return { 
      children: children
        .filter(child => child.happySessionId !== undefined)
        .map(child => ({
          startedBy: child.startedBy,
          happySessionId: child.happySessionId!,
          pid: child.pid
        }))
    }
  });

  typed.post('/migrate-sessions', {
    schema: {
      response: {
        200: z.object({
          inspected: z.number(),
          migrationRequested: z.number(),
          migrationFailed: z.number(),
          current: z.number(),
          skipped: z.number(),
          sessions: z.array(z.object({
            sessionId: z.string(),
            pid: z.number(),
            status: z.enum(['current', 'migration_requested', 'migration_failed', 'skipped']),
            reason: z.string().optional(),
          })),
        }),
        401: authSchema401,
        501: z.object({
          error: z.literal('migration_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!handleMigrateOldSessionRunners) {
      reply.code(501);
      return { error: 'migration_handler_unavailable' as const };
    }
    const migration = await handleMigrateOldSessionRunners();
    return {
      ...migration,
      sessions: migration.sessions.map((session) => ({ ...session })),
    };
  });

  // Stop specific session
  typed.post('/stop-session', {
    schema: {
      body: z.object({
        sessionId: z.string()
      }),
      response: {
        200: z.object({
          success: z.boolean()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
    const success = await stopSession(sessionId);
    return { success };
  });

  // Spawn new session
  typed.post('/spawn-session', {
    schema: {
      body: SpawnDaemonSessionRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        202: z.object({
          success: z.literal(false),
          status: z.literal('pending'),
          errorCode: z.literal(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT),
        }),
        401: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
          errorDetail: z.unknown().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { directory, sessionId, existingSessionId } = request.body;
    const spawnNonce = typeof request.body.spawnNonce === 'string' ? request.body.spawnNonce.trim() : '';
    const nonceAdmission = claimSpawnNonceAdmission(spawnNonce);
    if (nonceAdmission.type === 'success') {
      return {
        success: true,
        sessionId: nonceAdmission.sessionId,
        approvedNewDirectoryCreation: true,
      };
    }
    if (nonceAdmission.type === 'pending') {
      reply.code(202);
      return {
        success: false as const,
        status: 'pending' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      };
    }
    const normalizedDirectory = normalizeSpawnSessionDirectory(directory, process.env);

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${normalizedDirectory}, sessionId=${sessionId || 'new'}`);
    let result: SpawnSessionResult;
    try {
      const normalizedExistingSessionId = typeof existingSessionId === 'string' && existingSessionId.trim().length > 0
        ? existingSessionId.trim()
        : undefined;
      result = await spawnSession(
        mergeSpawnSessionOptions(
          request.body,
          {
            directory: normalizedDirectory,
            ...(normalizedExistingSessionId ? { existingSessionId: normalizedExistingSessionId } : {}),
          },
          normalizedExistingSessionId ? { omit: ['sessionId'] } : {},
        ) as SpawnSessionOptions,
      );
    } catch (error) {
      if (spawnNonce) {
        spawnNonceCorrelationByNonce.delete(spawnNonce);
      }
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          if (spawnNonce) {
            spawnNonceCorrelationByNonce.delete(spawnNonce);
          }
          reply.code(500);
          return {
            success: false,
            error: 'Failed to spawn session: no session ID returned',
          };
        }
        if (spawnNonce) {
          markSpawnNonceSuccess(spawnNonce, result.sessionId);
        }
        return {
          success: true,
          sessionId: result.sessionId,
          approvedNewDirectoryCreation: true,
        };

      case 'requestToApproveDirectoryCreation':
        if (spawnNonce) {
          spawnNonceCorrelationByNonce.delete(spawnNonce);
        }
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };

      case 'error':
        if (spawnNonce && result.errorCode !== SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
          spawnNonceCorrelationByNonce.delete(spawnNonce);
        }
        reply.code(500);
        return {
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };
    }
  });

  typed.post('/spawn-session/resolve', {
    schema: {
      body: z.object({
        spawnNonce: z.string().trim().min(1),
      }),
      response: {
        200: z.object({
          success: z.literal(true),
          status: z.enum(['success', 'pending', 'not_found']),
          sessionId: z.string().optional(),
        }),
        401: authSchema401,
      },
    },
    preHandler: requireAuth,
  }, async (request) => {
    const spawnNonce = request.body.spawnNonce.trim();
    pruneSpawnNonceCorrelation();
    const cached = spawnNonceCorrelationByNonce.get(spawnNonce);
    if (cached?.status === 'success' && isCanonicalSessionId(cached.sessionId)) {
      return {
        success: true as const,
        status: 'success' as const,
        sessionId: cached.sessionId.trim(),
      };
    }

    const matches = getChildren().filter((child) => child.spawnOptions?.spawnNonce === spawnNonce);
    const successMatch = matches.find((child) => isCanonicalSessionId(child.happySessionId));
    if (successMatch && isCanonicalSessionId(successMatch.happySessionId)) {
      markSpawnNonceSuccess(spawnNonce, successMatch.happySessionId);
      return {
        success: true as const,
        status: 'success' as const,
        sessionId: successMatch.happySessionId.trim(),
      };
    }

    if (matches.length > 0) {
      markSpawnNoncePending(spawnNonce);
      return {
        success: true as const,
        status: 'pending' as const,
      };
    }

    if (cached?.status === 'pending') {
      return {
        success: true as const,
        status: 'pending' as const,
      };
    }

    return {
      success: true as const,
      status: 'not_found' as const,
    };
  });

  typed.post('/continue-with-replay', {
    schema: {
      body: z.object({
        directory: z.string(),
        agent: z.string(),
        approvedNewDirectoryCreation: z.boolean().optional(),
        permissionMode: z.string().optional(),
        permissionModeUpdatedAt: z.number().optional(),
        modelId: z.string().optional(),
        modelUpdatedAt: z.number().optional(),
        replay: z.object({
          previousSessionId: z.string(),
          strategy: z.string().optional(),
          recentMessagesCount: z.number().optional(),
          maxSeedChars: z.number().optional(),
          seedMode: z.string().optional(),
        }),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        403: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
          errorDetail: z.unknown().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const normalizedDirectory = normalizeSpawnSessionDirectory(request.body.directory, process.env);
    const agentId = resolveCatalogAgentIdForCliSubcommand(request.body.agent);
    if (!agentId) {
      reply.code(400);
      return {
        success: false,
        error: 'Unknown agent id',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      };
    }

    let result: SpawnSessionResult;
    try {
      result = await continueSessionWithReplay(
        {
          directory: normalizedDirectory,
          agentId,
          approvedNewDirectoryCreation: request.body.approvedNewDirectoryCreation,
          permissionMode: request.body.permissionMode,
          permissionModeUpdatedAt: request.body.permissionModeUpdatedAt,
          modelId: request.body.modelId,
          modelUpdatedAt: request.body.modelUpdatedAt,
          replay: request.body.replay,
        },
        { spawnSession },
      );
    } catch (error) {
      const authStatus = readAuthenticationStatus(error);
      if (authStatus) {
        reply.code(authStatus);
        return {
          success: false,
          error: 'not_authenticated',
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          reply.code(500);
          return { success: false, error: 'Failed to spawn session: no session ID returned' };
        }
        return { success: true, sessionId: result.sessionId, approvedNewDirectoryCreation: true };
      case 'requestToApproveDirectoryCreation':
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };
      case 'error':
        reply.code(result.errorCode === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST ? 400 : 500);
        return {
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };
    }
  });

  // Stop daemon
  typed.post('/stop', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
        })
        .nullish(),
      response: {
        200: z.object({
          status: z.string()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const stopSessions = request.body?.stopSessions === true;
    logger.debug('[CONTROL SERVER] Stop daemon request received', { stopSessions });

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      const runBeforeShutdown = async (): Promise<void> => {
        if (!beforeShutdown) return;
        try {
          await beforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] beforeShutdown hook failed (best-effort)', error);
        }
      };

      void (async () => {
        try {
          if (stopSessions) {
            const children = getChildren();
            logger.debug(`[CONTROL SERVER] stopSessions requested: stopping ${children.length} tracked sessions`);
            for (const child of children) {
              const sessionId = typeof child.happySessionId === 'string' ? child.happySessionId.trim() : '';
              const fallbackSessionId =
                Number.isFinite(child.pid) && child.pid > 1 ? `PID-${Math.trunc(child.pid)}` : '';
              const id = sessionId || fallbackSessionId;
              if (!id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await prepareStopSession?.(child);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to prepare session ${id} before stop`, error);
              }
              try {
                // eslint-disable-next-line no-await-in-loop
                await stopSession(id);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to stop session ${id}`, error);
              }
            }
          }
          await runBeforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] stopSessions failed', error);
        } finally {
          requestShutdown();
        }
      })();
    }, 50);

    return { status: 'stopping' };
  });

  return app;
}

export function startDaemonControlServer({
  getChildren,
  machineId,
  stopSession,
  prepareStopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  handleConnectedServiceRuntimeAuthFailure,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleSessionConnectedServiceAuthSwitch,
  handleConnectedServiceQuotaSnapshot,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleCodexChatGptAuthTokensRefresh,
  handleMigrateOldSessionRunners,
  handleCodexDirectSessionLinkEnsure,
  runtimeAuthRecoveryScheduler,
  isShuttingDown,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  prepareStopSession?: (child: TrackedSession) => Promise<void> | void;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>) => Promise<unknown>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  isShuttingDown?: () => boolean;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
  }>) => Promise<unknown>;
  // QAE-1: user "Stop waiting" propagation — cancels the daemon-side durable
  // recovery wait state (runtime-auth recovery + inactive usage-limit stores).
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<SessionConnectedServiceAuthSwitchRpcParams>) => Promise<unknown>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>) => Promise<unknown>;
  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
  handleMigrateOldSessionRunners?: () => Promise<OldSessionRunnerMigrationResult>;
  handleCodexDirectSessionLinkEnsure?: (input: Readonly<{
    remoteSessionId: string;
    title: string;
    directory?: string;
  }>) => Promise<Readonly<{
    ok: boolean;
    sessionId?: string;
    created?: boolean;
    errorCode?: string;
    errorMessage?: string;
  }>>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      machineId,
      stopSession,
      prepareStopSession,
      spawnSession,
      requestShutdown,
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
      handleConnectedServiceRuntimeAuthFailure,
      handleConnectedServiceTurnLifecycle,
      handleConnectedServiceUsageLimitWaitResumeCancel,
      handleSessionConnectedServiceAuthSwitch,
      handleConnectedServiceQuotaSnapshot,
      handleConnectedServiceQuotaRecoveryCreditConsume,
      handleCodexChatGptAuthTokensRefresh,
      handleMigrateOldSessionRunners,
      handleCodexDirectSessionLinkEnsure,
      runtimeAuthRecoveryScheduler,
      isShuttingDown,
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
