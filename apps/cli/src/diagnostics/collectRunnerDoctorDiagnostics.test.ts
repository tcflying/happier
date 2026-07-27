import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  happyHomeDir: '',
  activeServerDir: '',
  readLockStatus: vi.fn(),
  listDaemonSessions: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return state.happyHomeDir;
    },
    get activeServerDir() {
      return state.activeServerDir;
    },
    get logsDir() {
      return join(state.happyHomeDir, 'logs');
    },
    activeServerId: 'local',
    currentCliVersion: '2.0.0',
    serverUrl: 'http://127.0.0.1:3000',
    webappUrl: 'http://127.0.0.1:5173',
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  listDaemonSessions: () => state.listDaemonSessions(),
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
  };
});

import { collectRunnerDoctorDiagnostics } from './collectRunnerDoctorDiagnostics';

describe('collectRunnerDoctorDiagnostics', () => {
  beforeEach(async () => {
    const root = join(tmpdir(), `happier-doctor-${process.pid}-${Date.now()}`);
    state.happyHomeDir = join(root, 'home');
    state.activeServerDir = join(root, 'server');
    await mkdir(join(state.happyHomeDir, 'tmp', 'session-runner-locks'), { recursive: true });
    await mkdir(join(state.happyHomeDir, 'logs'), { recursive: true });
    await mkdir(join(state.activeServerDir, 'session-mutations'), { recursive: true });
    state.readLockStatus.mockReset();
    state.listDaemonSessions.mockReset();
    state.listDaemonSessions.mockResolvedValue([]);
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
      'runner_log_stale',
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

  it('does not mislabel runner locks inactive when daemon session inventory is unavailable', async () => {
    await writeFile(
      join(state.happyHomeDir, 'tmp', 'session-runner-locks', 'session-unknown.json'),
      JSON.stringify({ sessionId: 'session-unknown' }),
      'utf8',
    );
    state.listDaemonSessions.mockRejectedValue(new Error('daemon unavailable'));
    state.readLockStatus.mockResolvedValue({
      ok: true,
      lock: {
        sessionId: 'session-unknown',
        pid: 100,
        acquiredAtMs: 1,
        generationId: 'generation-unknown',
      },
      lifecycle: {
        sessionId: 'session-unknown',
        pid: 100,
        generationId: 'generation-unknown',
        phase: 'running',
        phaseStartedAtMs: 59_999,
        heartbeatAtMs: 59_999,
        cliVersion: '2.0.0',
        runnerBuildId: 'current-build',
      },
    });

    const diagnostics = await collectRunnerDoctorDiagnostics({
      nowMs: 60_000,
      settings: {
        schemaVersion: 6,
        onboardingCompleted: true,
        activeServerId: 'local',
        servers: {},
      },
    });

    expect(diagnostics.map((entry) => entry.code)).not.toContain('inactive_session_runner_lock');
  });

  it('collects stale session log mtime and active-server machine identity', async () => {
    const nowMs = Date.now();
    const logPath = join(
      state.happyHomeDir,
      'logs',
      `2026-07-27-04-00-00-pid-200.log`,
    );
    await writeFile(
      join(state.happyHomeDir, 'tmp', 'session-runner-locks', 'session-log.json'),
      JSON.stringify({ sessionId: 'session-log' }),
      'utf8',
    );
    await writeFile(logPath, 'runner stopped writing\n', 'utf8');
    const staleLogTime = new Date(nowMs - 60_000);
    await utimes(logPath, staleLogTime, staleLogTime);
    state.readLockStatus.mockResolvedValue({
      ok: true,
      lock: {
        sessionId: 'session-log',
        pid: 200,
        acquiredAtMs: nowMs - 120_000,
        generationId: 'generation-log',
      },
      lifecycle: {
        sessionId: 'session-log',
        pid: 200,
        generationId: 'generation-log',
        phase: 'cleanup',
        phaseStartedAtMs: nowMs - 70_000,
        heartbeatAtMs: nowMs - 60_000,
        cleanupDeadlineAtMs: nowMs + 10_000,
        cliVersion: '2.0.0',
        runnerBuildId: 'current-build',
      },
    });

    const diagnostics = await collectRunnerDoctorDiagnostics({
      nowMs,
      settings: {
        schemaVersion: 6,
        onboardingCompleted: true,
        activeServerId: 'local',
        machineIdByServerId: { local: 'machine-local' },
        servers: {},
      },
    });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'runner_log_stale',
      data: expect.objectContaining({
        machineId: 'machine-local',
        sessionId: 'session-log',
        fileName: '2026-07-27-04-00-00-pid-200.log',
        logState: 'stale',
      }),
    }));
  });

  it('passes the active profile local relay URL into role validation', async () => {
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
            serverUrl: 'https://relay.example.test',
            localServerUrl: 'http://127.0.0.1:5173',
            webappUrl: 'http://localhost:5173',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      },
    });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'server_webapp_role_port_drift',
      severity: 'error',
      data: expect.objectContaining({
        serverId: 'local',
        profileLocalServerUrl: 'http://127.0.0.1:5173',
        driftKinds: ['same_endpoint'],
      }),
    }));
  });
});
