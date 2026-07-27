import type { SessionRunnerLockStatus } from '../sessionRunnerLock';
import type { TrackedSession } from '../types';

export type OldSessionRunnerMigrationReason =
  | 'cli_version_drift'
  | 'runner_build_drift'
  | 'runner_build_unknown'
  | 'pre_lifecycle_runner';

export type OldSessionRunnerMigrationSessionResult = Readonly<{
  sessionId: string;
  pid: number;
  status: 'current' | 'migration_requested' | 'migration_failed' | 'skipped';
  reason?:
    | OldSessionRunnerMigrationReason
    | 'duplicate_session'
    | 'missing_respawn_options'
    | 'lock_unavailable'
    | 'lock_owner_changed';
}>;

export type OldSessionRunnerMigrationResult = Readonly<{
  inspected: number;
  migrationRequested: number;
  migrationFailed: number;
  current: number;
  skipped: number;
  sessions: readonly OldSessionRunnerMigrationSessionResult[];
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveMigrationReason(params: Readonly<{
  status: Extract<SessionRunnerLockStatus, { ok: true }>;
  currentCliVersion: string;
  currentRunnerBuildId: string;
}>): OldSessionRunnerMigrationReason | null {
  const lifecycle = params.status.lifecycle;
  if (!lifecycle) return 'pre_lifecycle_runner';
  if (lifecycle.cliVersion !== params.currentCliVersion) return 'cli_version_drift';
  if (!params.currentRunnerBuildId) return null;
  if (!lifecycle.runnerBuildId) return 'runner_build_unknown';
  if (lifecycle.runnerBuildId !== params.currentRunnerBuildId) return 'runner_build_drift';
  return null;
}

export async function migrateOldSessionRunners(params: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  currentCliVersion: string;
  currentRunnerBuildId?: string | null;
  readSessionRunnerLockStatus: (params: Readonly<{ sessionId: string }>) => Promise<SessionRunnerLockStatus>;
  requestRestart: (tracked: TrackedSession) => boolean | Promise<boolean>;
}>): Promise<OldSessionRunnerMigrationResult> {
  const currentCliVersion = normalizeString(params.currentCliVersion);
  const currentRunnerBuildId = normalizeString(params.currentRunnerBuildId);
  const seenSessionIds = new Set<string>();
  const sessions: OldSessionRunnerMigrationSessionResult[] = [];

  for (const tracked of params.trackedSessions) {
    if (tracked.startedBy !== 'daemon') continue;
    const sessionId = normalizeString(tracked.happySessionId);
    if (!sessionId) continue;

    if (seenSessionIds.has(sessionId)) {
      sessions.push({
        sessionId,
        pid: tracked.pid,
        status: 'skipped',
        reason: 'duplicate_session',
      });
      continue;
    }
    seenSessionIds.add(sessionId);

    const directory = normalizeString(tracked.spawnOptions?.directory);
    if (!directory) {
      sessions.push({
        sessionId,
        pid: tracked.pid,
        status: 'skipped',
        reason: 'missing_respawn_options',
      });
      continue;
    }

    const lockStatus = await params.readSessionRunnerLockStatus({ sessionId }).catch(() => null);
    if (!lockStatus?.ok) {
      sessions.push({
        sessionId,
        pid: tracked.pid,
        status: 'skipped',
        reason: 'lock_unavailable',
      });
      continue;
    }
    if (lockStatus.lock.pid !== tracked.pid) {
      sessions.push({
        sessionId,
        pid: tracked.pid,
        status: 'skipped',
        reason: 'lock_owner_changed',
      });
      continue;
    }

    const reason = resolveMigrationReason({
      status: lockStatus,
      currentCliVersion,
      currentRunnerBuildId,
    });
    if (!reason) {
      sessions.push({ sessionId, pid: tracked.pid, status: 'current' });
      continue;
    }

    const requested = await Promise.resolve(params.requestRestart(tracked)).catch(() => false);
    sessions.push({
      sessionId,
      pid: tracked.pid,
      status: requested ? 'migration_requested' : 'migration_failed',
      reason,
    });
  }

  return {
    inspected: sessions.length,
    migrationRequested: sessions.filter((session) => session.status === 'migration_requested').length,
    migrationFailed: sessions.filter((session) => session.status === 'migration_failed').length,
    current: sessions.filter((session) => session.status === 'current').length,
    skipped: sessions.filter((session) => session.status === 'skipped').length,
    sessions,
  };
}
