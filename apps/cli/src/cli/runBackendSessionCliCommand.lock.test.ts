import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const heartbeat = vi.fn(async () => true);
const markCleanup = vi.fn(async () => true);
const release = vi.fn(async () => undefined);
const acquireSessionRunnerLock = vi.fn();

vi.mock('@/daemon/sessionRunnerLock', () => ({
  acquireSessionRunnerLock,
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({ credentials: { token: 'x' } })),
  ensureMachineIdForCredentials: vi.fn(async () => 'machine-1'),
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({ token: 'x' })),
  readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: vi.fn(async () => ({
    source: 'none',
    settings: {},
    settingsVersion: 0,
    loadedAtMs: Date.now(),
    whenRefreshed: null,
  })),
}));

describe('runBackendSessionCliCommand (session runner lock)', () => {
  beforeEach(() => {
    heartbeat.mockClear();
    markCleanup.mockClear();
    release.mockClear();
    acquireSessionRunnerLock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exits when --existing-session is already running on this machine', async () => {
    acquireSessionRunnerLock.mockResolvedValue({
      ok: false as const,
      reason: 'already_running' as const,
      heldByPid: 999,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as any);

    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await expect(
      runBackendSessionCliCommand({
        context: { args: ['codex', '--existing-session', 'sess_1'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      }),
    ).rejects.toThrow('exit:1');

    expect(acquireSessionRunnerLock).toHaveBeenCalledTimes(1);
    expect(loadRun).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('heartbeats while running and records bounded cleanup before releasing the generation', async () => {
    vi.useFakeTimers();
    acquireSessionRunnerLock.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_1',
      pid: 123,
      acquiredAtMs: 1,
      generationId: 'generation-1',
      lockPath: 'lock.json',
      heartbeat,
      markCleanup,
      readLifecycle: vi.fn(async () => null),
      release,
    });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');

    let finishRun!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    const command = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_1'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(run),
      agentIdForAccountSettings: 'codex' as any,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeat).toHaveBeenCalled();
    const heartbeatCallsBeforeCleanup = heartbeat.mock.calls.length;
    const cleanupStartedAtMs = Date.now();
    const {
      beginRegisteredSessionRunnerCleanup,
      finishRegisteredSessionRunnerCleanup,
    } = await import('@/daemon/sessionRunnerLifecycleRuntime');
    await beginRegisteredSessionRunnerCleanup(100);
    expect(markCleanup).toHaveBeenCalledWith({
      nowMs: cleanupStartedAtMs,
      deadlineAtMs: cleanupStartedAtMs + 100,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatCallsBeforeCleanup);
    await finishRegisteredSessionRunnerCleanup('completed');
    finishRun();
    await command;

    expect(markCleanup).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
