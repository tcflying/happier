import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disposeCodexAppServerProcess,
  type CodexAppServerProcessDisposalBoundary,
} from './disposeCodexAppServerProcess';

function createBoundary(overrides: Partial<CodexAppServerProcessDisposalBoundary> = {}) {
  const boundary: CodexAppServerProcessDisposalBoundary = {
    requestGracefulStop: vi.fn(),
    waitForExit: vi.fn(async () => undefined),
    terminateProcessTree: vi.fn(async () => undefined),
    hasProcessTreeResidue: vi.fn(async () => false),
    ...overrides,
  };
  return boundary;
}

describe('disposeCodexAppServerProcess', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes graceful cleanup without escalating', async () => {
    const boundary = createBoundary();

    const result = await disposeCodexAppServerProcess(boundary, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 250,
    });

    expect(result).toEqual({ outcome: 'graceful', processTreeResidue: false });
    expect(boundary.requestGracefulStop).toHaveBeenCalledOnce();
    expect(boundary.terminateProcessTree).not.toHaveBeenCalled();
  });

  it('escalates after the graceful deadline and verifies the process tree is gone', async () => {
    vi.useFakeTimers();
    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const boundary = createBoundary({
      waitForExit: vi.fn(async () => await exitPromise),
      terminateProcessTree: vi.fn(async () => {
        resolveExit?.();
      }),
    });

    const disposal = disposeCodexAppServerProcess(boundary, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await disposal;

    expect(result).toEqual({ outcome: 'forced', processTreeResidue: false });
    expect(boundary.terminateProcessTree).toHaveBeenCalledOnce();
    expect(boundary.hasProcessTreeResidue).toHaveBeenCalledOnce();
  });

  it('fails explicitly when verified process-tree residue remains after escalation', async () => {
    vi.useFakeTimers();
    const neverExits = new Promise<void>(() => {});
    const boundary = createBoundary({
      waitForExit: vi.fn(async () => await neverExits),
      hasProcessTreeResidue: vi.fn(async () => true),
    });

    const disposal = disposeCodexAppServerProcess(boundary, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 250,
    });
    const rejection = expect(disposal).rejects.toThrow(/process tree residue/i);
    await vi.advanceTimersByTimeAsync(1_250);
    await rejection;
  });
});
