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
 * "Active" means the runner can actually SERVE the session (consume pending messages, answer RPC).
 * A merely-signalable pid is not enough: a SIGSTOPped or zombie runner passes `kill(pid, 0)` but
 * serves nothing, and refusing a resume for it loses the user's message (incident 2026-06-12,
 * "Resume requested ... but session is already running"). Probe failures stay fail-closed:
 * an alive pid whose state cannot be inspected is treated as servable.
 */
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

  // A stopped/zombie runner cannot serve a resume even when the daemon holds a live
  // ChildProcess handle for it; reporting it inactive lets the resume respawn instead of
  // refusing and stranding the user's message in the pending queue.
  if (!(await isPidActivelyServing(pidToCheck, params.readProcessRunState))) return false;

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
