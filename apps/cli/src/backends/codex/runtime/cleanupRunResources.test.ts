import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupCodexRunResources } from './cleanupRunResources';

describe('cleanupCodexRunResources', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds a hanging cleanup stage, force-cleans synchronous resources, and reports timed_out', async () => {
    const onCleanupStart = vi.fn(async () => undefined);
    const onCleanupOutcome = vi.fn(async () => undefined);
    const stopHappierMcpServer = vi.fn();
    const clear = vi.fn();
    const keepAliveInterval = setInterval(() => undefined, 10_000);
    const cleanup = cleanupCodexRunResources({
      session: {
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => await new Promise<void>(() => undefined)),
        close: vi.fn(async () => undefined),
      } as any,
      reconnectionHandle: null,
      client: null,
      codexRuntime: null,
      stopHappierMcpServer,
      unmountRemoteUi: vi.fn(async () => undefined),
      keepAliveInterval,
      messageBuffer: { clear } as any,
      logDebug: vi.fn(),
      logActiveHandles: vi.fn(),
      cleanupBudgetMs: 100,
      onCleanupStart,
      onCleanupOutcome,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(onCleanupStart).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(cleanup).resolves.toBeUndefined();
    expect(onCleanupOutcome).toHaveBeenCalledWith('timed_out');
    expect(stopHappierMcpServer).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('reports completed when all cleanup stages finish within the total deadline', async () => {
    const onCleanupOutcome = vi.fn(async () => undefined);
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
      onCleanupStart: vi.fn(async () => undefined),
      onCleanupOutcome,
    });

    await expect(cleanup).resolves.toBeUndefined();
    expect(onCleanupOutcome).toHaveBeenCalledWith('completed');
  });
});
