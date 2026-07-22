import { describe, expect, it, vi } from 'vitest';

describe('waitForExistingSessionExitIfStopRequested', () => {
  it('does nothing when no tracked session has a stopRequestedAtMs marker for the session id', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const isSessionRunnerActive = vi.fn(async () => true);
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1' }],
    ]);

    const result = await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
      isPidAlive: async () => false,
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(isSessionRunnerActive).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('returns false when a stop-requested runner remains active through the deadline', async () => {
    vi.useFakeTimers();
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');
    const pidToTrackedSession = new Map<number, any>([
      [44, {
        pid: 44,
        happySessionId: 'sess-still-active',
        stopRequestedAtMs: 1,
      }],
    ]);

    const pending = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-still-active',
      pidToTrackedSession,
      isSessionRunnerActive: async () => true,
      isPidAlive: async () => true,
      timeoutMs: 100,
      pollIntervalMs: 25,
    });
    await vi.advanceTimersByTimeAsync(125);

    await expect(pending).resolves.toBe(false);
  });

  it('waits for the runner to exit when the session has an in-flight stop marker', async () => {
    vi.useFakeTimers();
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const activeStates = [true, true, false];
    const isSessionRunnerActive = vi.fn(async () => activeStates.shift() ?? false);
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    const promise = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
      isPidAlive: async () => false,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(isSessionRunnerActive).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('notifies the caller when a stopped tracked runner is no longer active', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const isSessionRunnerActive = vi.fn(async () => false);
    const onExitObserved = vi.fn();
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
      isPidAlive: async () => false,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      onExitObserved,
    });

    expect(onExitObserved).toHaveBeenCalledWith(1, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('does not complete the stop observation before the exit lifecycle obligation settles', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');
    let resolveExit = (): void => {
      throw new Error('Exit resolver was not installed');
    };
    let markExitObserved = (): void => {
      throw new Error('Exit observation resolver was not installed');
    };
    const exitObserved = new Promise<void>((resolve) => {
      markExitObserved = resolve;
    });
    const onExitObserved = vi.fn(() => new Promise<void>((resolve) => {
      markExitObserved();
      resolveExit = resolve;
    }));
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);
    let completed = false;

    const wait = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive: async () => false,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      onExitObserved,
    }).then(() => {
      completed = true;
    });

    await exitObserved;
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveExit();
    await wait;
    expect(completed).toBe(true);
  });

  it('can observe explicit tracked pids even when no stopRequestedAtMs marker exists', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const isSessionRunnerActive = vi.fn(async () => false);
    const onExitObserved = vi.fn();
    const pidToTrackedSession = new Map<number, any>([
      [6480, { happySessionId: 'sess-reattached' }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-reattached',
      pidToTrackedSession,
      isSessionRunnerActive,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      trackedPids: [6480],
      onExitObserved,
    });

    expect(onExitObserved).toHaveBeenCalledWith(6480, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });
});
