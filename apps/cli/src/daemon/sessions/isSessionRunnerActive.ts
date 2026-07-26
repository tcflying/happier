import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import {
  isSessionRunnerLifecycleAuthoritativelyStale,
  readSessionRunnerLockStatus,
  SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS,
  type SessionRunnerLockStatus,
} from '../sessionRunnerLock';
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

async function isLockActive(params: {
  sessionId: string;
  nowMs: number;
  heartbeatTimeoutMs: number;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<boolean> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status || !status.ok) return false;
  if (
    isSessionRunnerLifecycleAuthoritativelyStale({
      lifecycle: status.lifecycle ?? null,
      nowMs: params.nowMs,
      heartbeatTimeoutMs: params.heartbeatTimeoutMs,
    })
  ) {
    return false;
  }

  const pid = status.lock.pid;
  if (!(await isPidActivelyServing(pid, params.readProcessRunState))) return false;

  // If the lock PID is alive but its command hash is provably different, the OS reused
  // the PID for another process. Treat it as inactive so acquisition can break the stale lock.
  if (
    await storedProcessHashProvesCurrentPidReuse({
      storedProcessCommandHash: status.lock.processCommandHash,
      pid,
      getProcessCommandHash: params.getProcessCommandHash,
    })
  ) {
    return false;
  }

  // Fail-closed: a lock with a live servable PID is treated as active unless we can prove PID reuse.
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
  nowMs?: number;
  heartbeatTimeoutMs?: number;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;
  const nowMs = Math.max(1, Math.floor(params.nowMs ?? Date.now()));
  const heartbeatTimeoutMs = Math.max(
    1,
    Math.floor(params.heartbeatTimeoutMs ?? SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS),
  );
  const authoritativeLockStatus = await readLockStatus({ sessionId }).catch(() => null);
  if (
    authoritativeLockStatus?.ok
    && isSessionRunnerLifecycleAuthoritativelyStale({
      lifecycle: authoritativeLockStatus.lifecycle ?? null,
      nowMs,
      heartbeatTimeoutMs,
    })
  ) {
    // A daemon-tracked child handle is only an observation of a process. The
    // generation-fenced lifecycle is authoritative about whether that runner
    // can still serve, so an expired heartbeat/deadline must win.
    return false;
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

  return await isLockActive({
    sessionId,
    nowMs,
    heartbeatTimeoutMs,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    readSessionRunnerLockStatus: readLockStatus,
  });
}
