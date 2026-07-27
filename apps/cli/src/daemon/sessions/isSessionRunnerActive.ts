import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import {
  isSessionRunnerLifecycleAuthoritativelyStale,
  quarantineSessionRunnerGeneration as quarantineSessionRunnerGenerationDefault,
  readSessionRunnerLockStatus,
  SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS,
  type QuarantineSessionRunnerGenerationReason,
  type QuarantineSessionRunnerGenerationResult,
  type SessionRunnerLockStatus,
} from '../sessionRunnerLock';
import { challengeSessionRunnerControl as challengeSessionRunnerControlDefault } from '../sessionRunnerControlChallenge';
import {
  isValidProcessCommandHash,
  readSessionRunnerProcessIdentity,
  storedProcessHashProvesPidReuse,
  type SessionRunnerProcessCommandHashReader,
} from '../sessionRunnerProcessIdentity';
import type { SessionRunnerServiceability } from './pendingQueueWake';

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function trackedSessionMatchesSessionId(tracked: TrackedSession, sessionId: string): boolean {
  const trackedHappySessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  const trackedExistingSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  return trackedHappySessionId === sessionId || trackedExistingSessionId === sessionId;
}

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;
type ChallengeSessionRunnerControl = (params: Readonly<{
  sessionId: string;
  generationId: string;
  controlPort: number;
}>) => Promise<boolean>;
type QuarantineSessionRunnerGeneration = (params: Readonly<{
  sessionId: string;
  expectedGenerationId: string;
  reason: QuarantineSessionRunnerGenerationReason;
}>) => Promise<QuarantineSessionRunnerGenerationResult>;
const DEFAULT_CONTROL_CHALLENGE_STARTUP_GRACE_MS = 5_000;

/**
 * This is process-presence evidence for duplicate-spawn fencing, not proof that the runner can
 * serve session control. Exact-session serviceability is established separately by
 * `probeSessionRunnerServiceability`.
 */
async function isPidPresentForDuplicateFence(pid: number, readProcessRunState: ReadProcessRunState): Promise<boolean> {
  const state = await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  return state === 'servable';
}

async function isPidActivelyServing(pid: number, readProcessRunState: ReadProcessRunState): Promise<boolean> {
  const state = await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  return state === 'servable';
}

async function storedProcessHashProvesCurrentPidReuse(params: {
  storedProcessCommandHash: string | null | undefined;
  pid: number;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
}): Promise<boolean> {
  if (!isValidProcessCommandHash(params.storedProcessCommandHash)) return false;
  return storedProcessHashProvesPidReuse({
    storedProcessCommandHash: params.storedProcessCommandHash,
    currentIdentity: await readSessionRunnerProcessIdentity({
      pid: params.pid,
      getProcessCommandHash: params.getProcessCommandHash,
    }),
  });
}

async function quarantineOrKeepGenerationOccupied(params: {
  sessionId: string;
  status: Extract<SessionRunnerLockStatus, { ok: true }>;
  reason: QuarantineSessionRunnerGenerationReason;
  quarantineSessionRunnerGeneration: QuarantineSessionRunnerGeneration;
}): Promise<boolean> {
  const generationId = params.status.lock.generationId;
  if (!generationId) return false;
  let result: QuarantineSessionRunnerGenerationResult | null = null;
  try {
    result = await params.quarantineSessionRunnerGeneration({
      sessionId: params.sessionId,
      expectedGenerationId: generationId,
      reason: params.reason,
    });
  } catch {
    result = null;
  }
  // A failed quarantine leaves ownership unresolved. Keep the slot occupied so
  // callers cannot create a duplicate runner behind a generation we failed to fence.
  return result?.ok !== true;
}

async function isLockActive(params: {
  sessionId: string;
  status: Extract<SessionRunnerLockStatus, { ok: true }>;
  nowMs: number;
  heartbeatTimeoutMs: number;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  challengeSessionRunnerControl: ChallengeSessionRunnerControl;
  quarantineSessionRunnerGeneration: QuarantineSessionRunnerGeneration;
  controlChallengeStartupGraceMs: number;
}): Promise<boolean> {
  const status = params.status;
  if (
    isSessionRunnerLifecycleAuthoritativelyStale({
      lifecycle: status.lifecycle ?? null,
      nowMs: params.nowMs,
      heartbeatTimeoutMs: params.heartbeatTimeoutMs,
    })
  ) {
    return await quarantineOrKeepGenerationOccupied({
      sessionId: params.sessionId,
      status,
      reason: 'heartbeat_stale',
      quarantineSessionRunnerGeneration: params.quarantineSessionRunnerGeneration,
    });
  }

  const pid = status.lock.pid;
  if (!(await isPidActivelyServing(pid, params.readProcessRunState))) {
    return await quarantineOrKeepGenerationOccupied({
      sessionId: params.sessionId,
      status,
      reason: 'runner_not_serving',
      quarantineSessionRunnerGeneration: params.quarantineSessionRunnerGeneration,
    });
  }

  // If the lock PID is alive but its command hash is provably different, the OS reused
  // the PID for another process. Treat it as inactive so acquisition can break the stale lock.
  if (
    await storedProcessHashProvesCurrentPidReuse({
      storedProcessCommandHash: status.lock.processCommandHash,
      pid,
      getProcessCommandHash: params.getProcessCommandHash,
    })
  ) {
    return await quarantineOrKeepGenerationOccupied({
      sessionId: params.sessionId,
      status,
      reason: 'pid_identity_reused',
      quarantineSessionRunnerGeneration: params.quarantineSessionRunnerGeneration,
    });
  }

  const generationId = status.lock.generationId;
  if (generationId) {
    const lifecycle = status.lifecycle;
    const controlPort = lifecycle?.controlPort;
    const controlIdentityReady = lifecycle?.generationId === generationId
      && lifecycle.pid === status.lock.pid
      && typeof controlPort === 'number'
    if (
      !controlIdentityReady
      && params.nowMs - status.lock.acquiredAtMs <= params.controlChallengeStartupGraceMs
    ) {
      return true;
    }
    const challengePassed = controlIdentityReady
      && await params.challengeSessionRunnerControl({
        sessionId: params.sessionId,
        generationId,
        controlPort,
      }).catch(() => false);
    if (!challengePassed) {
      return await quarantineOrKeepGenerationOccupied({
        sessionId: params.sessionId,
        status,
        reason: 'control_challenge_failed',
        quarantineSessionRunnerGeneration: params.quarantineSessionRunnerGeneration,
      });
    }
  }

  // Legacy locks have no generation endpoint to challenge. Keep a live exact PID
  // fail-closed; the explicit old-runner migration path upgrades these runners.
  return true;
}

async function isTrackedSessionActive(params: {
  sessionId: string;
  tracked: TrackedSession;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
}): Promise<boolean> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return false;

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;

  // A stopped/zombie runner is absent for duplicate-spawn purposes even when the daemon still
  // holds a ChildProcess handle for it.
  if (!(await isPidPresentForDuplicateFence(pidToCheck, params.readProcessRunState))) return false;

  // A matching live PID is not enough: the OS may have reused the PID after the original
  // runner exited. Unknown process identity still fails closed to avoid duplicate spawns.
  if (
    await storedProcessHashProvesCurrentPidReuse({
      storedProcessCommandHash: params.tracked.processCommandHash,
      pid: pidToCheck,
      getProcessCommandHash: params.getProcessCommandHash,
    })
  ) {
    return false;
  }

  return true;
}

export async function isSessionRunnerActive(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
  challengeSessionRunnerControl?: ChallengeSessionRunnerControl;
  quarantineSessionRunnerGeneration?: QuarantineSessionRunnerGeneration;
  nowMs?: number;
  heartbeatTimeoutMs?: number;
  controlChallengeStartupGraceMs?: number;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;
  const challengeSessionRunnerControl = params.challengeSessionRunnerControl
    ?? challengeSessionRunnerControlDefault;
  const quarantineSessionRunnerGeneration = params.quarantineSessionRunnerGeneration
    ?? quarantineSessionRunnerGenerationDefault;
  const nowMs = Math.max(1, Math.floor(params.nowMs ?? Date.now()));
  const heartbeatTimeoutMs = Math.max(
    1,
    Math.floor(params.heartbeatTimeoutMs ?? SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS),
  );
  const controlChallengeStartupGraceMs = Math.max(
    0,
    Math.floor(params.controlChallengeStartupGraceMs ?? DEFAULT_CONTROL_CHALLENGE_STARTUP_GRACE_MS),
  );
  const authoritativeLockStatus = await readLockStatus({ sessionId }).catch(() => null);
  if (authoritativeLockStatus?.ok) {
    // The generation-fenced lock is authoritative. A daemon ChildProcess handle
    // must never override a failed heartbeat/control challenge for that generation.
    return await isLockActive({
      sessionId,
      status: authoritativeLockStatus,
      nowMs,
      heartbeatTimeoutMs,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      challengeSessionRunnerControl,
      quarantineSessionRunnerGeneration,
      controlChallengeStartupGraceMs,
    });
  }

  for (const tracked of params.trackedSessions) {
    if (await isTrackedSessionActive({
      sessionId,
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
    })) {
      return true;
    }
  }
  return false;
}

export type SessionRunnerServiceabilityProbe =
  | Readonly<{ state: 'runner_absent' }>
  | Readonly<{ state: 'runner_unknown'; reason: 'runner_presence_unproven' }>
  | Readonly<{ state: 'runner_present'; control: SessionRunnerServiceability }>;

export type SessionRunnerResumeDecision =
  | Readonly<{ action: 'spawn' }>
  | Readonly<{ action: 'adopt' }>
  | Readonly<{ action: 'wait_for_exit'; reason: 'runtime_terminating' }>
  | Readonly<{ action: 'fence'; reason: string }>;

export function resolveSessionRunnerResumeDecision(probe: SessionRunnerServiceabilityProbe): SessionRunnerResumeDecision {
  if (probe.state === 'runner_absent') return { action: 'spawn' };
  if (probe.state === 'runner_unknown') return { action: 'fence', reason: probe.reason };
  if (probe.control.state === 'servable') return { action: 'adopt' };
  if (probe.control.state === 'recoverable_unservable' && probe.control.reason === 'runtime_terminating') {
    return { action: 'wait_for_exit', reason: 'runtime_terminating' };
  }
  return { action: 'fence', reason: probe.control.reason };
}

export async function probeSessionRunnerServiceability(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  probeCapability: () => Promise<SessionRunnerServiceability>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const trackedSessions = Array.from(params.trackedSessions);
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;
  let lockStatusPromise: Promise<SessionRunnerLockStatus> | null = null;
  const readLockStatusOnce = async (input: { sessionId: string }): Promise<SessionRunnerLockStatus> => {
    lockStatusPromise ??= readLockStatus(input).catch((error: unknown) => ({
      ok: false,
      reason: 'io_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
    return await lockStatusPromise;
  };
  const runnerPresent = await isSessionRunnerActive({
    ...params,
    trackedSessions,
    readProcessRunState,
    readSessionRunnerLockStatus: readLockStatusOnce,
  });
  if (!runnerPresent) {
    for (const tracked of trackedSessions) {
      if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
      const childPid = typeof tracked.childProcess?.pid === 'number' ? tracked.childProcess.pid : null;
      const runState = await readProcessRunState(childPid ?? tracked.pid).catch(() => null);
      if (runState !== 'dead' && runState !== 'zombie') {
        return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
      }
    }

    const lockStatus = await readLockStatusOnce({ sessionId });
    if (!lockStatus.ok) {
      return lockStatus.reason === 'not_found'
        ? { state: 'runner_absent' }
        : { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
    const lockRunState = await readProcessRunState(lockStatus.lock.pid).catch(() => null);
    return lockRunState === 'dead' || lockRunState === 'zombie'
      ? { state: 'runner_absent' }
      : { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  return { state: 'runner_present', control: await params.probeCapability() };
}
