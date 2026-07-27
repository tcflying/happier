import { createHash } from 'node:crypto';

import type { Credentials } from '@/persistence';
import {
  detectSessionTurnActivity,
  detectSessionTurnActivityFromProjection,
  readSessionProjectedPendingRequestCount,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { detectLatestSessionTurnActivitySnapshot } from '@/session/query/detectLatestSessionTurnActivity';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

const SHARED_IDLE_OBSERVER_MAX_LIFETIME_MS = 60 * 60_000;

type IdleObservationResult = Readonly<{ idle: true; observedAt: number }>;

interface SharedIdleObserver {
  readonly controller: AbortController;
  readonly promise: Promise<IdleObservationResult>;
  waiterCount: number;
  settled: boolean;
}

const sharedIdleObservers = new Map<string, SharedIdleObserver>();

function sharedIdleObserverKey(token: string, sessionId: string): string {
  const credentialFingerprint = createHash('sha256').update(token, 'utf8').digest('hex');
  return `${credentialFingerprint}:${sessionId}`;
}

function acquireSharedIdleObserver(input: Readonly<{
  key: string;
  create: (signal: AbortSignal) => Promise<IdleObservationResult>;
}>): SharedIdleObserver {
  const existing = sharedIdleObservers.get(input.key);
  if (existing) {
    existing.waiterCount += 1;
    return existing;
  }

  const controller = new AbortController();
  const observer: SharedIdleObserver = {
    controller,
    promise: Promise.resolve().then(() => input.create(controller.signal)),
    waiterCount: 1,
    settled: false,
  };
  sharedIdleObservers.set(input.key, observer);
  const settle = () => {
    observer.settled = true;
    if (sharedIdleObservers.get(input.key) === observer) {
      sharedIdleObservers.delete(input.key);
    }
  };
  observer.promise.then(settle, settle);
  return observer;
}

async function waitOnSharedIdleObserver(input: Readonly<{
  key: string;
  observer: SharedIdleObserver;
  timeoutMs: number;
}>): Promise<IdleObservationResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.observer.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    input.observer.waiterCount = Math.max(0, input.observer.waiterCount - 1);
    if (input.observer.waiterCount === 0 && !input.observer.settled) {
      if (sharedIdleObservers.get(input.key) === input.observer) {
        sharedIdleObservers.delete(input.key);
      }
      input.observer.controller.abort();
    }
  }
}

function unknownTranscriptTurnActivity(): SessionTurnActivity {
  return {
    pendingUserTurns: 1,
    activeTaskInFlight: false,
    turnInFlight: true,
  };
}

export async function waitForSessionIdle(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  timeoutMs: number;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; idle: true; observedAt: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'timeout'; candidates?: string[] }>
> {
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());

  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const agentStateCiphertext =
    typeof sessionTarget.rawSession.agentState === 'string' ? String(sessionTarget.rawSession.agentState).trim() : null;
  const initialProjectedActivity = detectSessionTurnActivityFromProjection(sessionTarget.rawSession);
  let initialTranscriptActivity: SessionTurnActivity | null = null;
  let initialTranscriptActivityUnavailable = false;
  if (!initialProjectedActivity || !initialProjectedActivity.turnInFlight) {
    try {
      initialTranscriptActivity = await detectSessionTurnActivity({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        encryptionMode: sessionTarget.mode,
        encryptionKey: sessionTarget.ctx.encryptionKey,
        encryptionVariant: sessionTarget.ctx.encryptionVariant,
        transcriptFetchTimeoutMs: remainingTimeoutMs(),
      });
    } catch {
      initialTranscriptActivityUnavailable = true;
    }
  }
  let initialTurnActivity: SessionTurnActivity;
  if (initialProjectedActivity?.turnInFlight) {
    initialTurnActivity = initialProjectedActivity;
  } else if (initialTranscriptActivity?.turnInFlight) {
    initialTurnActivity = initialTranscriptActivity;
  } else if (initialTranscriptActivityUnavailable) {
    initialTurnActivity = unknownTranscriptTurnActivity();
  } else {
    initialTurnActivity = initialProjectedActivity ?? initialTranscriptActivity ?? {
      pendingUserTurns: 0,
      activeTaskInFlight: false,
      turnInFlight: false,
    };
  }
  const initialTurnActivityRequiresTranscriptIdleEvidence =
    initialTranscriptActivityUnavailable
    || (
      initialProjectedActivity !== null
      && !initialProjectedActivity.turnInFlight
      && initialTranscriptActivity?.turnInFlight === true
    );
  const initialProjectedPendingRequestCount = readSessionProjectedPendingRequestCount(sessionTarget.rawSession);

  try {
    const observerKey = sharedIdleObserverKey(params.credentials.token, sessionTarget.sessionId);
    const observer = acquireSharedIdleObserver({
      key: observerKey,
      create: (signal) => waitForIdleViaSocket({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        ctx: sessionTarget.ctx,
        sessionEncryptionMode: sessionTarget.mode,
        timeoutMs: SHARED_IDLE_OBSERVER_MAX_LIFETIME_MS,
        signal,
        initialTurnActivity,
        initialTurnActivityRequiresTranscriptIdleEvidence,
        recheckTurnActivity: async () =>
          initialProjectedActivity
            ? detectLatestSessionTurnActivitySnapshot({
              token: params.credentials.token,
              sessionId: sessionTarget.sessionId,
              encryptionMode: sessionTarget.mode,
              encryptionKey: sessionTarget.ctx.encryptionKey,
              encryptionVariant: sessionTarget.ctx.encryptionVariant,
              transcriptFetchTimeoutMs: SHARED_IDLE_OBSERVER_MAX_LIFETIME_MS,
            })
            : detectSessionTurnActivity({
              token: params.credentials.token,
              sessionId: sessionTarget.sessionId,
              encryptionMode: sessionTarget.mode,
              encryptionKey: sessionTarget.ctx.encryptionKey,
              encryptionVariant: sessionTarget.ctx.encryptionVariant,
              transcriptFetchTimeoutMs: SHARED_IDLE_OBSERVER_MAX_LIFETIME_MS,
            }),
        ...(initialProjectedPendingRequestCount !== null
          ? { initialAgentStateSummary: { pendingRequestsCount: initialProjectedPendingRequestCount } }
          : {}),
        preferProjectionUpdates: initialProjectedActivity !== null,
        initialAgentStateCiphertextBase64:
          initialProjectedPendingRequestCount === null && agentStateCiphertext && agentStateCiphertext.length > 0
            ? agentStateCiphertext
            : null,
      }),
    });
    const result = await waitOnSharedIdleObserver({
      key: observerKey,
      observer,
      timeoutMs: remainingTimeoutMs(),
    });
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      ...result,
    };
  } catch {
    return {
      ok: false,
      code: 'timeout',
    };
  }
}
