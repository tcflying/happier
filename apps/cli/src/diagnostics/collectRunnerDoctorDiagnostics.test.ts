import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  happyHomeDir: '',
  activeServerDir: '',
  readLockStatus: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return state.happyHomeDir;
    },
    get activeServerDir() {
      return state.activeServerDir;
    },
    activeServerId: 'local',
    currentCliVersion: '2.0.0',
    serverUrl: 'http://127.0.0.1:3000',
    webappUrl: 'http://127.0.0.1:5173',
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  listDaemonSessions: vi.fn(async () => []),
}));

vi.mock('@/daemon/processRunState', () => ({
  readProcessRunState: vi.fn(async () => 'servable'),
}));

vi.mock('@/daemon/sessionRunnerBuildId', () => ({
  resolveSessionRunnerBuildId: vi.fn(async () => 'current-build'),
}));

vi.mock('@/daemon/sessionRunnerLock', () => {
  return {
    SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS: 30_000,
    readSessionRunnerLockStatus: (params: unknown) => state.readLockStatus(params),
    isSessionRunnerLifecycleAuthoritativelyStale: (params: {
      lifecycle: { phase: string; heartbeatAtMs: number; cleanupDeadlineAtMs?: number } | null;
      nowMs: number;
      heartbeatTimeoutMs: number;
    }) => Boolean(
      params.lifecycle
      && (
        params.lifecycle.phase === 'finished'
        || (
          params.lifecycle.phase === 'cleanup'
          && typeof params.lifecycle.cleanupDeadlineAtMs === 'number'
          && params.nowMs > params.lifecycle.cleanupDeadlineAtMs
        )
        || params.nowMs - params.lifecycle.heartbeatAtMs > params.heartbeatTimeoutMs
      )
    ),
  };
});

import { collectRunnerDoctorDiagnostics } from './collectRunnerDoctorDiagnostics';

describe('collectRunnerDoctorDiagnostics', () => {
  beforeEach(async () => {
    const root = join(tmpdir(), `happier-doctor-${process.pid}-${Date.now()}`);
    state.happyHomeDir = join(root, 'home');
    state.activeServerDir = join(root, 'server');
    await mkdir(join(state.happyHomeDir, 'tmp', 'session-runner-locks'), { recursive: true });
    await mkdir(join(state.activeServerDir, 'session-mutations'), { recursive: true });
    state.readLockStatus.mockReset();
  });

  afterEach(async () => {
    await rm(join(state.happyHomeDir, '..'), { recursive: true, force: true });
  });

  it('collects lock lifecycle and durable mutation dead-letter evidence', async () => {
    await writeFile(
      join(state.happyHomeDir, 'tmp', 'session-runner-locks', 'session-1.json'),
      JSON.stringify({ sessionId: 'session-1' }),
      'utf8',
    );
    await writeFile(
      join(state.activeServerDir, 'session-mutations', 'session-session-1.dead-letter.json'),
      JSON.stringify({
        v: 1,
        entries: [
          { sessionId: 'session-1' },
          { sessionId: 'session-1' },
        ],
      }),
      'utf8',
    );
    state.readLockStatus.mockResolvedValue({
      ok: true,
      lock: {
        sessionId: 'session-1',
        pid: 100,
        acquiredAtMs: 1,
        generationId: 'generation-1',
      },
      lifecycle: {
        sessionId: 'session-1',
        pid: 100,
        generationId: 'generation-1',
        phase: 'running',
        phaseStartedAtMs: 1,
        heartbeatAtMs: 1,
        cliVersion: '1.0.0',
        runnerBuildId: 'old-build',
      },
    });

    const diagnostics = await collectRunnerDoctorDiagnostics({
      nowMs: 60_000,
      settings: {
        schemaVersion: 6,
        onboardingCompleted: true,
        activeServerId: 'local',
        servers: {
          local: {
            id: 'local',
            name: 'Local',
            serverUrl: 'http://127.0.0.1:3000',
            webappUrl: 'http://127.0.0.1:5173',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      },
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'inactive_session_runner_lock',
      'runner_heartbeat_stale',
      'runner_cli_build_drift',
      'session_mutation_dead_letter',
    ]);
    expect(diagnostics.at(-1)).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        sessionIds: ['session-1'],
        entryCount: 2,
      }),
    }));
  });
});
