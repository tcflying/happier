import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerProcessDisposalBoundary,
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

  it('fails closed when process-tree enumeration is unavailable', async () => {
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: {
        pid: 100,
        stdin: { end: vi.fn() },
        kill: vi.fn(),
      } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses: vi.fn(async () => {
          throw new Error('ps unavailable');
        }),
        isPidAlive: vi.fn(() => false),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(true);
  });

  it('merges a descendant discovered after the graceful snapshot and verifies it', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([{ pid: 100, ppid: 1 }])
      .mockResolvedValueOnce([{ pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }]);
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: {
        pid: 100,
        stdin: { end: vi.fn() },
        kill: vi.fn(),
      } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => pid === 101),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(true);
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });
});
