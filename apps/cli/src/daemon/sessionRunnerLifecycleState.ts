export type SessionRunnerLifecyclePhase = 'running' | 'cleanup' | 'finished';
export type SessionRunnerCleanupOutcome = 'completed' | 'failed' | 'timed_out' | 'superseded';

export type SessionRunnerLifecycleState = Readonly<{
  sessionId: string;
  pid: number;
  generationId: string;
  phase: SessionRunnerLifecyclePhase;
  phaseStartedAtMs: number;
  heartbeatAtMs: number;
  cleanupDeadlineAtMs?: number;
  cleanupOutcome?: SessionRunnerCleanupOutcome;
  cliVersion: string;
  runnerBuildId?: string;
}>;

export function isSessionRunnerLifecycleAuthoritativelyStale(params: Readonly<{
  lifecycle: SessionRunnerLifecycleState | null;
  nowMs: number;
  heartbeatTimeoutMs: number;
}>): boolean {
  const lifecycle = params.lifecycle;
  if (!lifecycle) return false;
  if (lifecycle.phase === 'finished') return true;
  if (
    lifecycle.phase === 'cleanup'
    && typeof lifecycle.cleanupDeadlineAtMs === 'number'
    && params.nowMs > lifecycle.cleanupDeadlineAtMs
  ) {
    return true;
  }
  return params.nowMs - lifecycle.heartbeatAtMs > params.heartbeatTimeoutMs;
}
