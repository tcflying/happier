import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRunningInspection } from './controlClient';

const stopDaemonMock = vi.fn(async () => undefined);
const restartAllDaemonSessionRunnersMock = vi.fn(async () => ({
  ok: true,
  mode: 'force_current_cli' as const,
  requestedCount: 1,
  restartedCount: 1,
  skippedCount: 0,
  failedCount: 0,
  results: [
    {
      ok: true,
      status: 'restarted' as const,
      sessionId: 'sess-1',
    },
  ],
}));
const requestDaemonSessionRunnerMigrationMock = vi.fn(async () => ({
  inspected: 1,
  migrationRequested: 1,
  migrationFailed: 0,
  current: 0,
  skipped: 0,
  sessions: [],
}));
const inspectDaemonRunningStateMock = vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({
  status: 'running' as const,
  state: {
    pid: 1234,
    startedAt: 100,
    httpPort: 9400,
    startedWithCliVersion: '0.2.8',
    startedWithPublicReleaseChannel: 'preview',
    startupSource: 'manual',
    controlToken: 'token-1',
  },
}));
const spawnDetachedDaemonStartSyncMock = vi.fn<() => Promise<{ pid?: number; unref: ReturnType<typeof vi.fn> }>>(
  async () => ({ unref: vi.fn() }),
);

describe('restartDaemonAndWait', () => {
  afterEach(() => {
    stopDaemonMock.mockReset();
    requestDaemonSessionRunnerMigrationMock.mockReset();
    restartAllDaemonSessionRunnersMock.mockReset();
    inspectDaemonRunningStateMock.mockReset();
    spawnDetachedDaemonStartSyncMock.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS;
  });

  async function importSubject() {
    vi.doMock('@/daemon/controlClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
      return {
        ...actual,
        stopDaemon: stopDaemonMock,
        inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonRunningStateMock,
        requestDaemonSessionRunnerMigration: requestDaemonSessionRunnerMigrationMock,
        restartAllDaemonSessionRunners: restartAllDaemonSessionRunnersMock,
      };
    });
    vi.doMock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
      spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
    }));

    stopDaemonMock.mockImplementation(async () => undefined);
    requestDaemonSessionRunnerMigrationMock.mockImplementation(async () => ({
      inspected: 1,
      migrationRequested: 1,
      migrationFailed: 0,
      current: 0,
      skipped: 0,
      sessions: [],
    }));
    restartAllDaemonSessionRunnersMock.mockImplementation(async () => ({
      ok: true,
      mode: 'force_current_cli',
      requestedCount: 1,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [
        {
          ok: true,
          status: 'restarted',
          sessionId: 'sess-1',
        },
      ],
    }));
    inspectDaemonRunningStateMock.mockImplementationOnce(async () => ({
      status: 'running',
      state: {
        pid: 1234,
        startedAt: 100,
        httpPort: 9400,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        controlToken: 'token-1',
      },
    }));
    inspectDaemonRunningStateMock.mockImplementation(async () => ({
      status: 'running',
      state: {
        pid: 5678,
        startedAt: 200,
        httpPort: 9500,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'self-restart',
        controlToken: 'token-2',
      },
    }));
    spawnDetachedDaemonStartSyncMock.mockImplementation(async () => ({ unref: vi.fn() }));
    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '1';
    process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS = '1';
    process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS = '1';

    return await import('./restartDaemonAndWait');
  }

  it('restarts through the self-restart takeover path by default', async () => {
    const { restartDaemonAndWait } = await importSubject();

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: true,
    });

    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
    }));
  });

  it('omits takeover only when explicitly disabled', async () => {
    const { restartDaemonAndWait } = await importSubject();

    await expect(restartDaemonAndWait({ stopSessions: false, takeover: false })).resolves.toEqual({
      ok: true,
    });

    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
    }));
    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.not.objectContaining({
      env: expect.anything(),
    }));
  });

  it('migrates old runners only when explicitly requested', async () => {
    const { restartDaemonAndWait } = await importSubject();

    await expect(restartDaemonAndWait({ migrateSessions: true })).resolves.toEqual({ ok: true });

    expect(requestDaemonSessionRunnerMigrationMock).toHaveBeenCalledOnce();
    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
  });

  it('fails the restart result when old-runner migration reports a failure', async () => {
    const { restartDaemonAndWait } = await importSubject();
    requestDaemonSessionRunnerMigrationMock.mockResolvedValueOnce({
      inspected: 1,
      migrationRequested: 1,
      migrationFailed: 1,
      current: 0,
      skipped: 0,
      sessions: [],
    });

    await expect(restartDaemonAndWait({ migrateSessions: true })).resolves.toEqual({ ok: false });
  });

  it('reports success when final status proves a new daemon after the stop request errors', async () => {
    const { restartDaemonAndWait } = await importSubject();
    stopDaemonMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: true,
    });

    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
    }));
  });

  it('does not report success when the restarted daemon is not proven running', async () => {
    const { restartDaemonAndWait } = await importSubject();
    const notRunningInspection: DaemonRunningInspection = {
      status: 'not-running',
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(notRunningInspection)
      .mockResolvedValueOnce({
        status: 'running',
        state: {
          pid: 1234,
          startedAt: 100,
          httpPort: 9400,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'manual',
          controlToken: 'token-1',
        },
      });

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });

    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
  });

  it('reports starting when final proof times out but the replacement child is still alive', async () => {
    const { restartDaemonAndWait } = await importSubject();
    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '1';
    process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS = '1';
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue({
        status: 'not-running',
      })
      .mockResolvedValueOnce({
        status: 'running',
        state: {
          pid: 1234,
          startedAt: 100,
          httpPort: 9400,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'manual',
          controlToken: 'token-1',
        },
      });
    spawnDetachedDaemonStartSyncMock.mockResolvedValueOnce({
      pid: process.pid,
      unref: vi.fn(),
    });

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: true,
      status: 'starting',
    });
  });

  it('reports success when final proof sees a new daemon after restart', async () => {
    const { restartDaemonAndWait } = await importSubject();

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: true,
    });

    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
    expect(spawnDetachedDaemonStartSyncMock).toHaveBeenCalledTimes(1);
    expect(inspectDaemonRunningStateMock).toHaveBeenCalledTimes(3);
  });

  it('waits for final proof snapshots until a new daemon is running within the start budget', async () => {
    const { restartDaemonAndWait } = await importSubject();
    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '5';
    process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS = '1';
    const stableReplacementInspection: DaemonRunningInspection = {
      status: 'running',
      state: {
        pid: 5678,
        startedAt: 200,
        httpPort: 9500,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'self-restart',
        controlToken: 'token-2',
      },
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(stableReplacementInspection)
      .mockResolvedValueOnce({
        status: 'running',
        state: {
          pid: 1234,
          startedAt: 100,
          httpPort: 9400,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'manual',
          controlToken: 'token-1',
        },
      })
      .mockResolvedValueOnce({
        status: 'not-running',
      })
      .mockResolvedValueOnce({
        status: 'starting',
        pid: 5678,
      })
      .mockResolvedValueOnce(stableReplacementInspection);

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: true,
    });

    expect(inspectDaemonRunningStateMock).toHaveBeenCalledTimes(5);
  });

  it('does not report success when the proven replacement exits during the stability window', async () => {
    const { restartDaemonAndWait } = await importSubject();
    process.env.HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS = '1';
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValueOnce({
        status: 'running',
        state: {
          pid: 1234,
          startedAt: 100,
          httpPort: 9400,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'manual',
          controlToken: 'token-1',
        },
      })
      .mockResolvedValueOnce({
        status: 'running',
        state: {
          pid: 5678,
          startedAt: 200,
          httpPort: 9500,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'self-restart',
          controlToken: 'token-2',
        },
      })
      .mockResolvedValueOnce({
        status: 'not-running',
      });

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });
  });

  it('does not report success when restart keeps the same daemon identity', async () => {
    const { restartDaemonAndWait } = await importSubject();
    const sameRunningInspection: DaemonRunningInspection = {
      status: 'running' as const,
      state: {
        pid: 2222,
        startedAt: 500,
        httpPort: 9400,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        controlToken: 'same-token',
      },
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(sameRunningInspection)
      .mockResolvedValueOnce(sameRunningInspection);

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });
  });

  it('does not report success when a previous starting daemon becomes the same running daemon', async () => {
    const { restartDaemonAndWait } = await importSubject();
    const sameRunningInspection: DaemonRunningInspection = {
      status: 'running' as const,
      state: {
        pid: 3333,
        startedAt: 700,
        httpPort: 9400,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        controlToken: 'starting-token',
      },
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(sameRunningInspection)
      .mockResolvedValueOnce({
        status: 'starting',
        state: {
          pid: 3333,
          startedAt: 700,
          httpPort: 9400,
          startedWithCliVersion: '0.2.8',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'manual',
          controlToken: 'starting-token',
        },
      })
      .mockResolvedValueOnce(sameRunningInspection);

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });
  });

  it('does not report success when a previous pid-only starting daemon becomes the same running daemon', async () => {
    const { restartDaemonAndWait } = await importSubject();
    const sameRunningInspection: DaemonRunningInspection = {
      status: 'running' as const,
      state: {
        pid: 4444,
        startedAt: 800,
        httpPort: 9400,
        startedWithCliVersion: '0.2.8',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        controlToken: 'pid-only-token',
      },
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(sameRunningInspection)
      .mockResolvedValueOnce({
        status: 'starting',
        pid: 4444,
      })
      .mockResolvedValueOnce(sameRunningInspection);

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });
  });

  it('does not report success when daemon is not stable after restart wait', async () => {
    const { restartDaemonAndWait } = await importSubject();
    const notRunningInspection = {
      status: 'not-running' as const,
    };
    inspectDaemonRunningStateMock.mockReset();
    inspectDaemonRunningStateMock
      .mockResolvedValue(notRunningInspection)
      .mockResolvedValueOnce(notRunningInspection);

    await expect(restartDaemonAndWait({ stopSessions: true })).resolves.toEqual({
      ok: false,
    });
  });

  it('returns the structured runner restart result when requested', async () => {
    const { restartDaemonAndWait } = await importSubject();

    await expect(restartDaemonAndWait({
      stopSessions: false,
      restartSessionRunners: true,
      restartSessionRunnersMode: 'force_current_cli',
    })).resolves.toEqual({
      ok: true,
      sessionRunnerRestart: {
        ok: true,
        mode: 'force_current_cli',
        requestedCount: 1,
        restartedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        results: [
          {
            ok: true,
            status: 'restarted',
            sessionId: 'sess-1',
          },
        ],
      },
    });
    expect(restartAllDaemonSessionRunnersMock).toHaveBeenCalledWith({
      mode: 'force_current_cli',
      dryRun: false,
      reason: 'daemon_restart_session_runners',
    });
  });
});
