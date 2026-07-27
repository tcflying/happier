import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRunnerLifecycleAttempt } from '@/daemon/sessionRunnerLifecycleRuntime';
import type { SessionRunnerCleanupOutcome } from '@/daemon/sessionRunnerLock';
import { cleanupCodexRunResources } from './cleanupRunResources';

describe('cleanupCodexRunResources', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues through the force finalizer after flush times out and only then reports timed_out', async () => {
    const onCleanupStart = vi.fn(async (
      _deadlineAtMs: number,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const stopHappierMcpServer = vi.fn();
    const clear = vi.fn();
    const close = vi.fn(async () => undefined);
    const forceCloseSession = vi.fn(async () => undefined);
    const unmountRemoteUi = vi.fn(async () => undefined);
    const keepAliveInterval = setInterval(() => undefined, 10_000);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => await new Promise<void>(() => undefined)),
        close,
      } as any,
      reconnectionHandle: null,
      client: { forceCloseSession } as any,
      codexRuntime: null,
      stopHappierMcpServer,
      unmountRemoteUi,
      keepAliveInterval,
      messageBuffer: { clear } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart,
      onCleanupOutcome,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(onCleanupStart.mock.calls[0]?.[0]).toBe(1_100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(forceCloseSession).toHaveBeenCalledOnce();
    expect(unmountRemoteUi).toHaveBeenCalledOnce();
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('timed_out');
    expect(stopHappierMcpServer).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('continues cleanup when lifecycle cleanup marking fails', async () => {
    const close = vi.fn(async () => undefined);
    const forceCloseSession = vi.fn(async () => undefined);
    const unmountRemoteUi = vi.fn(async () => undefined);
    const stopHappierMcpServer = vi.fn();
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close,
      } as any,
      reconnectionHandle: null,
      client: { forceCloseSession } as any,
      codexRuntime: null,
      stopHappierMcpServer,
      unmountRemoteUi,
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => {
        throw new Error('lifecycle unavailable');
      }),
      onCleanupOutcome,
    });

    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(forceCloseSession).toHaveBeenCalledOnce();
    expect(unmountRemoteUi).toHaveBeenCalledOnce();
    expect(stopHappierMcpServer).toHaveBeenCalledOnce();
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('failed');
  });

  it('reports failed after a rejected stage while still running later cleanup stages', async () => {
    const close = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const unmountRemoteUi = vi.fn(async () => undefined);
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {
          throw new Error('flush failed');
        }),
        close,
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: { reset },
      stopHappierMcpServer: vi.fn(),
      unmountRemoteUi,
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => undefined),
      onCleanupOutcome,
    });

    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(unmountRemoteUi).toHaveBeenCalledOnce();
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('failed');
  });

  it('passes the same absolute deadline to lifecycle state and the cleanup executor', async () => {
    const onCleanupStart = vi.fn(async (
      _deadlineAtMs: number,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: { reset: vi.fn(async () => undefined) },
      stopHappierMcpServer: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart,
      onCleanupOutcome,
    });

    await expect(cleanup).resolves.toBeUndefined();
    expect(onCleanupStart.mock.calls[0]?.[0]).toBe(1_100);
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('completed');
  });

  it('bounds a non-settling lifecycle start marker and still runs force finalizers', async () => {
    const close = vi.fn(async () => undefined);
    const forceCloseSession = vi.fn(async () => undefined);
    const unmountRemoteUi = vi.fn(async () => undefined);
    const stopHappierMcpServer = vi.fn();
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => undefined);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close,
      } as any,
      reconnectionHandle: null,
      client: { forceCloseSession } as any,
      codexRuntime: null,
      stopHappierMcpServer,
      unmountRemoteUi,
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => await new Promise<void>(() => undefined)),
      onCleanupOutcome,
    });
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(settled).toBe(true);
    await cleanup;
    expect(close).toHaveBeenCalledOnce();
    expect(forceCloseSession).toHaveBeenCalledOnce();
    expect(unmountRemoteUi).toHaveBeenCalledOnce();
    expect(stopHappierMcpServer).toHaveBeenCalledOnce();
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('timed_out');
  });

  it('does not hang after resources close when lifecycle outcome persistence never settles', async () => {
    const onCleanupOutcome = vi.fn(async (
      _outcome: SessionRunnerCleanupOutcome,
      _attempt?: SessionRunnerLifecycleAttempt,
    ) => await new Promise<void>(() => undefined));
    const stopHappierMcpServer = vi.fn();
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: { forceCloseSession: vi.fn(async () => undefined) } as any,
      codexRuntime: null,
      stopHappierMcpServer,
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => undefined),
      onCleanupOutcome,
    });
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toBe(true);
    await cleanup;
    expect(stopHappierMcpServer).toHaveBeenCalledOnce();
    expect(onCleanupOutcome.mock.calls[0]?.[0]).toBe('completed');
  });

  it('fences a lifecycle start attempt that settles after its timeout', async () => {
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let lateMutation = false;
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: null,
      stopHappierMcpServer: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async (_deadlineAtMs: number, attempt?: { isActive: () => boolean }) => {
        await startGate;
        if (attempt?.isActive() !== false) lateMutation = true;
      }),
      onCleanupOutcome: vi.fn(async () => undefined),
    } as any);

    await vi.advanceTimersByTimeAsync(50);
    await cleanup;
    resolveStart();
    await Promise.resolve();

    expect(lateMutation).toBe(false);
  });

  it('fences a lifecycle outcome attempt that settles after its timeout', async () => {
    let resolveOutcome!: () => void;
    const outcomeGate = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    let lateRelease = false;
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: null,
      stopHappierMcpServer: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => undefined),
      onCleanupOutcome: vi.fn(async (
        _outcome: string,
        attempt?: { isActive: () => boolean },
      ) => {
        await outcomeGate;
        if (attempt?.isActive() !== false) lateRelease = true;
      }),
    } as any);

    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    resolveOutcome();
    await Promise.resolve();

    expect(lateRelease).toBe(false);
  });

  it('gives lifecycle outcome persistence a commit token that cannot be claimed after timeout', async () => {
    let resolveOutcome!: () => void;
    const outcomeGate = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    let commitTokenObserved = false;
    let lateRelease = false;
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: null,
      stopHappierMcpServer: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval: setInterval(() => undefined, 10_000),
      messageBuffer: { clear: vi.fn() } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart: vi.fn(async () => undefined),
      onCleanupOutcome: vi.fn(async (
        _outcome: string,
        attempt?: {
          isActive: () => boolean;
          tryCommit?: () => boolean;
        },
      ) => {
        commitTokenObserved = typeof attempt?.tryCommit === 'function';
        await outcomeGate;
        if (attempt?.tryCommit?.()) lateRelease = true;
      }),
    } as any);

    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    resolveOutcome();
    await Promise.resolve();

    expect(commitTokenObserved).toBe(true);
    expect(lateRelease).toBe(false);
  });
});
