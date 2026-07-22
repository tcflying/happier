import type { TrackedSession } from '../types';

type ExitObservation = Readonly<{
  reason: 'process-missing';
  code: null;
  signal: null;
}>;

function sleep(ms: number): Promise<void> {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trackedSessionMatchesExistingSessionId(trackedSession: TrackedSession, sessionId: string): boolean {
  if (trackedSession.happySessionId === sessionId) return true;

  const existingSessionId =
    trackedSession.spawnOptions && typeof (trackedSession.spawnOptions as any).existingSessionId === 'string'
      ? String((trackedSession.spawnOptions as any).existingSessionId).trim()
      : '';
  return existingSessionId === sessionId;
}

function collectStopRequestedMatchingPids(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  trackedPids?: ReadonlyArray<number>;
}>): number[] {
  const explicitTrackedPids = Array.isArray(params.trackedPids)
    ? params.trackedPids.filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)
    : [];
  if (explicitTrackedPids.length > 0) {
    return explicitTrackedPids.filter((pid) => {
      const trackedSession = params.pidToTrackedSession.get(pid);
      return !!trackedSession && trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId);
    });
  }
  const pids: number[] = [];
  for (const [pid, trackedSession] of params.pidToTrackedSession.entries()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      pids.push(pid);
    }
  }
  return pids;
}

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  isSessionRunnerActive: (sessionId: string) => Promise<boolean>;
  timeoutMs: number;
  pollIntervalMs: number;
  trackedPids?: ReadonlyArray<number>;
  isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  onExitObserved?: (pid: number, exit: ExitObservation) => void | Promise<void>;
}>): Promise<boolean> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return false;

  const initialMatchingPids = collectStopRequestedMatchingPids({
    sessionId: normalizedSessionId,
    pidToTrackedSession: params.pidToTrackedSession,
    trackedPids: params.trackedPids,
  });
  if (initialMatchingPids.length === 0) return false;

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const start = Date.now();
  const isPidAlive = params.isPidAlive ?? isPidAliveDefault;
  while (Date.now() - start <= timeoutMs) {
    const active = await params.isSessionRunnerActive(normalizedSessionId);
    const matchingPids = collectStopRequestedMatchingPids({
      sessionId: normalizedSessionId,
      pidToTrackedSession: params.pidToTrackedSession,
      trackedPids: params.trackedPids,
    });
    const pidsToCheck = matchingPids.length > 0 ? matchingPids : initialMatchingPids;
    const pidLiveness = await Promise.all(pidsToCheck.map(async (pid) => await isPidAlive(pid)));
    if (!active && pidLiveness.every((alive) => !alive)) {
      for (const pid of pidsToCheck) {
        await params.onExitObserved?.(pid, { reason: 'process-missing', code: null, signal: null });
      }
      return true;
    }
    await sleep(params.pollIntervalMs);
  }
  return false;
}
