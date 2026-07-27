import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  happyHomeDir: '',
  activeServerDir: '',
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
    serverUrl: 'http://127.0.0.1:52211',
    webappUrl: 'http://127.0.0.1:18287',
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  listDaemonSessions: vi.fn(async () => []),
}));

vi.mock('@/daemon/processRunState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/processRunState')>();
  return {
    ...actual,
    readProcessRunState: vi.fn(async () => 'servable'),
  };
});

vi.mock('@/daemon/sessionRunnerBuildId', () => ({
  resolveSessionRunnerBuildId: vi.fn(async () => 'current-build'),
}));

import {
  acquireSessionRunnerLock,
  readSessionRunnerLockStatus,
  sessionRunnerLockPathForSessionId,
} from '@/daemon/sessionRunnerLock';
import { collectRunnerDoctorDiagnostics } from './collectRunnerDoctorDiagnostics';

describe('collectRunnerDoctorDiagnostics real stale lock fixture', () => {
  beforeEach(async () => {
    const root = join(tmpdir(), `happier-doctor-real-lock-${process.pid}-${Date.now()}`);
    state.happyHomeDir = join(root, 'home');
    state.activeServerDir = join(root, 'server');
    await mkdir(join(state.happyHomeDir, 'logs'), { recursive: true });
    await mkdir(join(state.activeServerDir, 'session-mutations'), { recursive: true });
  });

  afterEach(async () => {
    await rm(join(state.happyHomeDir, '..'), { recursive: true, force: true });
  });

  it('reads a real stale generation, lifecycle, log, and dead-letter from disk', async () => {
    const nowMs = Date.now();
    const sessionId = 'session-real-stale';
    const acquired = await acquireSessionRunnerLock({
      happyHomeDir: state.happyHomeDir,
      sessionId,
      pid: process.pid,
      nowMs: nowMs - 120_000,
      cliVersion: '1.0.0',
      runnerBuildId: 'old-build',
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error(`Failed to create real runner lock fixture: ${acquired.reason}`);

    expect(await acquired.markCleanup({
      nowMs: nowMs - 90_000,
      deadlineAtMs: nowMs - 60_000,
    })).toBe(true);

    const logFileName = `2026-07-27-04-00-00-pid-${process.pid}.log`;
    const logPath = join(state.happyHomeDir, 'logs', logFileName);
    await writeFile(logPath, 'stale runner log\n', 'utf8');
    const staleLogTime = new Date(nowMs - 60_000);
    await utimes(logPath, staleLogTime, staleLogTime);
    await writeFile(
      join(state.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`),
      JSON.stringify({ v: 1, entries: [{ sessionId }] }),
      'utf8',
    );

    const diagnostics = await collectRunnerDoctorDiagnostics({
      nowMs,
      settings: {
        schemaVersion: 6,
        onboardingCompleted: true,
        activeServerId: 'local',
        machineIdByServerId: { local: 'machine-real' },
        servers: {
          local: {
            id: 'local',
            name: 'Local',
            serverUrl: 'http://127.0.0.1:52211',
            webappUrl: 'http://127.0.0.1:18287',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      },
    });

    expect(new Set(diagnostics.map((entry) => entry.code))).toEqual(new Set([
      'inactive_session_runner_lock',
      'runner_cleanup_overdue',
      'runner_heartbeat_stale',
      'runner_log_stale',
      'runner_cli_build_drift',
      'session_mutation_dead_letter',
    ]));
    expect(diagnostics.find((entry) => entry.code === 'runner_log_stale')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          machineId: 'machine-real',
          sessionId,
          pid: process.pid,
          generationId: acquired.generationId,
          cleanupPhase: 'cleanup',
          fileName: logFileName,
          recoveryRecommendation: expect.any(String),
        }),
      }),
    );

    const lockStatus = await readSessionRunnerLockStatus({
      happyHomeDir: state.happyHomeDir,
      sessionId,
    });
    expect(lockStatus).toEqual(expect.objectContaining({
      ok: true,
      lock: expect.objectContaining({ generationId: acquired.generationId }),
      lifecycle: expect.objectContaining({ phase: 'cleanup' }),
    }));
    expect(sessionRunnerLockPathForSessionId({
      happyHomeDir: state.happyHomeDir,
      sessionId,
    })).not.toBeNull();
  });
});
