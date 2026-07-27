import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseSessionRunnerLockResult } from '@/daemon/sessionRunnerLock';

const heartbeat = vi.fn(async () => true);
const markCleanup = vi.fn(async () => true);
const setControlPort = vi.fn(async () => true);
const release = vi.fn(async (): Promise<ReleaseSessionRunnerLockResult> => ({ ok: true }));
const acquireSessionRunnerLock = vi.fn();
const closeControlChallengeServer = vi.fn(async () => {});
const startSessionRunnerControlChallengeServer = vi.fn(async () => ({
  port: 43_210,
  close: closeControlChallengeServer,
}));

vi.mock('@/daemon/sessionRunnerLock', () => ({
  acquireSessionRunnerLock,
}));

vi.mock('@/daemon/sessionRunnerControlChallenge', () => ({
  startSessionRunnerControlChallengeServer,
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
    setControlPort.mockClear();
    release.mockClear();
    closeControlChallengeServer.mockClear();
    startSessionRunnerControlChallengeServer.mockClear();
    markCleanup.mockResolvedValue(true);
    release.mockResolvedValue({ ok: true as const });
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
      setControlPort,
      heartbeat,
      markCleanup,
      readLifecycle: vi.fn(async () => null),
      release,
    });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');

    let finishRun!: () => void;
    const run = vi.fn(async (_opts: any) => {
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
    expect(startSessionRunnerControlChallengeServer).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      generationId: 'generation-1',
    });
    expect(setControlPort).toHaveBeenCalledWith(43_210);
    expect(heartbeat).toHaveBeenCalled();
    const heartbeatCallsBeforeCleanup = heartbeat.mock.calls.length;
    const cleanupStartedAtMs = Date.now();
    const lifecycle = run.mock.calls[0]?.[0].sessionRunnerCleanupLifecycle;
    expect(lifecycle).toBeDefined();
    await lifecycle.begin(cleanupStartedAtMs + 100);
    expect(markCleanup).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: cleanupStartedAtMs,
      deadlineAtMs: cleanupStartedAtMs + 100,
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatCallsBeforeCleanup);
    await lifecycle.finish('completed');
    finishRun();
    await command;

    expect(markCleanup).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(closeControlChallengeServer).toHaveBeenCalledOnce();
  });

  it('keeps cleanup lifecycle callbacks scoped to the runner that owns them', async () => {
    const markCleanupA = vi.fn(async () => true);
    const markCleanupB = vi.fn(async () => true);
    const releaseA = vi.fn(async (): Promise<ReleaseSessionRunnerLockResult> => ({ ok: true }));
    const releaseB = vi.fn(async (): Promise<ReleaseSessionRunnerLockResult> => ({ ok: true }));
    acquireSessionRunnerLock
      .mockResolvedValueOnce({
        ok: true as const,
        sessionId: 'sess_a',
        pid: 123,
        acquiredAtMs: 1,
        generationId: 'generation-a',
        lockPath: 'lock-a.json',
        setControlPort,
        heartbeat,
        markCleanup: markCleanupA,
        readLifecycle: vi.fn(async () => null),
        release: releaseA,
      })
      .mockResolvedValueOnce({
        ok: true as const,
        sessionId: 'sess_b',
        pid: 456,
        acquiredAtMs: 2,
        generationId: 'generation-b',
        lockPath: 'lock-b.json',
        setControlPort,
        heartbeat,
        markCleanup: markCleanupB,
        readLifecycle: vi.fn(async () => null),
        release: releaseB,
      });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');

    let finishA!: () => void;
    let finishB!: () => void;
    const runA = vi.fn(async (_opts: any) => {
      await new Promise<void>((resolve) => {
        finishA = resolve;
      });
    });
    const runB = vi.fn(async (_opts: any) => {
      await new Promise<void>((resolve) => {
        finishB = resolve;
      });
    });
    const commandA = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_a'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(runA),
      agentIdForAccountSettings: 'codex' as any,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const commandB = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_b'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(runB),
      agentIdForAccountSettings: 'codex' as any,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const lifecycleA = runA.mock.calls[0]?.[0].sessionRunnerCleanupLifecycle;
    const lifecycleB = runB.mock.calls[0]?.[0].sessionRunnerCleanupLifecycle;
    expect(lifecycleA).toBeDefined();
    expect(lifecycleB).toBeDefined();

    await lifecycleA.begin(Date.now() + 100);
    await lifecycleA.finish('completed');
    expect(markCleanupA).toHaveBeenCalledOnce();
    expect(releaseA).toHaveBeenCalledOnce();
    expect(markCleanupB).not.toHaveBeenCalled();
    expect(releaseB).not.toHaveBeenCalled();

    finishA();
    await commandA;

    await lifecycleB.begin(Date.now() + 100);
    await lifecycleB.finish('completed');
    expect(markCleanupB).toHaveBeenCalledOnce();
    expect(releaseB).toHaveBeenCalledOnce();

    finishB();
    await commandB;
  });

  it('does not release a cleanup generation until the force finalizer confirms completion', async () => {
    vi.useFakeTimers();
    acquireSessionRunnerLock.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_1',
      pid: 123,
      acquiredAtMs: 1,
      generationId: 'generation-1',
      lockPath: 'lock.json',
      setControlPort,
      heartbeat,
      markCleanup,
      readLifecycle: vi.fn(async () => null),
      release,
    });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');
    let finishRun!: () => void;
    const run = vi.fn(async (_opts: any) => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    const command = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_1'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(run),
      agentIdForAccountSettings: 'codex' as any,
    });

    await vi.advanceTimersByTimeAsync(1);
    const lifecycle = run.mock.calls[0]?.[0].sessionRunnerCleanupLifecycle;
    expect(lifecycle).toBeDefined();
    await lifecycle.begin(Date.now() + 100);
    finishRun();
    await command;
    expect(release).not.toHaveBeenCalled();
  });

  it('does not treat markCleanup false as a successful lifecycle transition', async () => {
    markCleanup.mockResolvedValue(false);
    acquireSessionRunnerLock.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_mark_false',
      pid: 123,
      acquiredAtMs: 1,
      generationId: 'generation-mark-false',
      lockPath: 'lock.json',
      setControlPort,
      heartbeat,
      markCleanup,
      readLifecycle: vi.fn(async () => null),
      release,
    });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');
    let finishRun!: () => void;
    let lifecycle: any;
    const run = vi.fn(async (opts: any) => {
      lifecycle = opts.sessionRunnerCleanupLifecycle;
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    const command = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_mark_false'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(run),
      agentIdForAccountSettings: 'codex' as any,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await expect(lifecycle.begin(Date.now() + 100)).rejects.toThrow(/mark cleanup/i);
    expect(release).not.toHaveBeenCalled();

    finishRun();
    await expect(command).rejects.toThrow(/mark cleanup/i);
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps the generation owned and reports failure until release returns ok', async () => {
    release
      .mockResolvedValueOnce({ ok: false as const, reason: 'not_owner' as const })
      .mockResolvedValue({ ok: true as const });
    acquireSessionRunnerLock.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_release_result',
      pid: 123,
      acquiredAtMs: 1,
      generationId: 'generation-release-result',
      lockPath: 'lock.json',
      setControlPort,
      heartbeat,
      markCleanup,
      readLifecycle: vi.fn(async () => null),
      release,
    });
    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');
    let finishRun!: () => void;
    let lifecycle: any;
    const run = vi.fn(async (opts: any) => {
      lifecycle = opts.sessionRunnerCleanupLifecycle;
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    const command = runBackendSessionCliCommand({
      context: { args: ['codex', '--existing-session', 'sess_release_result'], terminalRuntime: null } as any,
      loadRun: vi.fn().mockResolvedValue(run),
      agentIdForAccountSettings: 'codex' as any,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await lifecycle.begin(Date.now() + 100);
    await expect(lifecycle.finish('completed')).rejects.toThrow(/release/i);
    expect(release).toHaveBeenCalledTimes(1);

    finishRun();
    await command;
    expect(release).toHaveBeenCalledTimes(1);
  });
});
