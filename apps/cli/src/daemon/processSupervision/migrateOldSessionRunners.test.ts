import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { migrateOldSessionRunners } from './migrateOldSessionRunners';

function tracked(sessionId: string, pid: number): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: sessionId,
    pid,
    spawnOptions: {
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      resume: `native-${sessionId}`,
    },
  };
}

describe('migrateOldSessionRunners', () => {
  it('migrates only drifted or pre-lifecycle runners when explicitly invoked', async () => {
    const sessions = [
      tracked('sess-current', 101),
      tracked('sess-old', 102),
      tracked('sess-pre-lifecycle', 103),
      tracked('sess-owner-changed', 104),
    ];
    const requestRestart = vi.fn<(tracked: TrackedSession) => Promise<boolean>>(async () => true);

    const result = await migrateOldSessionRunners({
      trackedSessions: sessions,
      currentCliVersion: '2.0.0',
      currentRunnerBuildId: 'build-current',
      readSessionRunnerLockStatus: async ({ sessionId }) => {
        if (sessionId === 'sess-pre-lifecycle') {
          return {
            ok: true as const,
            lock: { sessionId, pid: 103, acquiredAtMs: 1 },
          };
        }
        const current = sessionId === 'sess-current';
        const lockPid = sessionId === 'sess-owner-changed' ? 204 : current ? 101 : 102;
        return {
          ok: true as const,
          lock: {
            sessionId,
            pid: lockPid,
            acquiredAtMs: 1,
            generationId: current ? 'generation-current' : 'generation-old',
          },
          lifecycle: {
            sessionId,
            pid: lockPid,
            generationId: current ? 'generation-current' : 'generation-old',
            phase: 'running' as const,
            phaseStartedAtMs: 1,
            heartbeatAtMs: 1,
            cliVersion: current ? '2.0.0' : '1.9.0',
            runnerBuildId: current ? 'build-current' : 'build-old',
          },
        };
      },
      requestRestart,
    });

    expect(requestRestart.mock.calls.map(([session]) => session.happySessionId)).toEqual([
      'sess-old',
      'sess-pre-lifecycle',
    ]);
    expect(result).toEqual({
      inspected: 4,
      migrationRequested: 2,
      migrationFailed: 0,
      current: 1,
      skipped: 1,
      sessions: [
        { sessionId: 'sess-current', pid: 101, status: 'current' },
        { sessionId: 'sess-old', pid: 102, status: 'migration_requested', reason: 'cli_version_drift' },
        { sessionId: 'sess-pre-lifecycle', pid: 103, status: 'migration_requested', reason: 'pre_lifecycle_runner' },
        { sessionId: 'sess-owner-changed', pid: 104, status: 'skipped', reason: 'lock_owner_changed' },
      ],
    });
  });
});
