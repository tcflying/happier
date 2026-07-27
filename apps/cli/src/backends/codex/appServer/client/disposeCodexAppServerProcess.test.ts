import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerProcessDisposalBoundary,
  disposeCodexAppServerProcess,
  type CodexAppServerProcessDisposalBoundary,
} from './disposeCodexAppServerProcess';

const UNBOUNDED_TEST_DEADLINE_AT_MS = Number.MAX_SAFE_INTEGER;

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

  it('passes one absolute deadline through forced termination and exit recheck', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const neverExits = new Promise<void>(() => {});
    const boundary = createBoundary({
      waitForExit: vi.fn(async () => await neverExits),
      hasProcessTreeResidue: vi.fn(async () => false),
    });

    const disposal = disposeCodexAppServerProcess(boundary, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(350);
    await expect(disposal).resolves.toEqual({
      outcome: 'forced',
      processTreeResidue: false,
    });

    expect(boundary.terminateProcessTree).toHaveBeenCalledWith(1_350);
    expect(Date.now()).toBe(1_350);
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
      .mockResolvedValueOnce([{ pid: 100, ppid: 1, startTimeMs: 1_000 }])
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
      ]);
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

  it('walks through an already tracked child to discover a late grandchild', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
      ])
      .mockResolvedValue([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
        { pid: 102, ppid: 101, startTimeMs: 1_200 },
      ]);
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => pid === 102),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await boundary.terminateProcessTree(Date.now() + 25);
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(true);
  });

  it('walks from every tracked process after a child is reparented', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
      ])
      .mockResolvedValue([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 1, startTimeMs: 1_100 },
        { pid: 102, ppid: 101, startTimeMs: 1_200 },
      ]);
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => pid === 102),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await boundary.terminateProcessTree(Date.now() + 25);
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(true);
  });

  it('fails closed when an enumerated tracked process is temporarily missing but still alive', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
      ])
      .mockResolvedValue([{ pid: 100, ppid: 1, startTimeMs: 1_000 }]);
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => pid === 101),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(true);
  });

  it('does not force-kill a reused Windows root pid', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([{ pid: 100, ppid: 1, startTimeMs: 1_000 }])
      .mockResolvedValueOnce([{ pid: 100, ppid: 1, startTimeMs: 9_900 }]);
    const terminateWindowsTree = vi.fn();
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn(() => true),
        platform: 'win32',
        terminateWindowsTree,
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);

    expect(listProcesses).toHaveBeenCalledTimes(2);
    expect(terminateWindowsTree).not.toHaveBeenCalled();
  });

  it('does not force-kill a Windows root pid when its command identity changed', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([{
        pid: 100,
        ppid: 1,
        startTimeMs: 1_000,
        cmd: 'codex app-server',
      }])
      .mockResolvedValueOnce([{
        pid: 100,
        ppid: 1,
        startTimeMs: 1_000,
        cmd: 'unrelated-process --same-pid',
      }]);
    const terminateWindowsTree = vi.fn();
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn(() => true),
        platform: 'win32',
        terminateWindowsTree,
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);

    expect(listProcesses).toHaveBeenCalledTimes(2);
    expect(terminateWindowsTree).not.toHaveBeenCalled();
  });

  it('does not force-kill a Windows root pid when its original generation cannot be proven', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([{ pid: 100, ppid: 1 }])
      .mockResolvedValueOnce([{ pid: 100, ppid: 1 }]);
    const readProcessStartTimeMs = vi.fn(async () => null);
    const terminateWindowsTree = vi.fn();
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        readProcessStartTimeMs,
        isPidAlive: vi.fn(() => true),
        platform: 'win32',
        terminateWindowsTree,
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);

    expect(readProcessStartTimeMs).toHaveBeenCalledWith(100);
    expect(terminateWindowsTree).not.toHaveBeenCalled();
  });

  it('terminates verified reparented and late Windows descendants before their ancestors', async () => {
    const alive = new Set([100, 101, 102]);
    let enumerations = 0;
    const listProcesses = vi.fn(async () => {
      enumerations += 1;
      const entries = enumerations === 1
        ? [
            { pid: 100, ppid: 1, startTimeMs: 1_000, cmd: 'codex app-server' },
            { pid: 101, ppid: 100, startTimeMs: 1_100 },
          ]
        : [
            { pid: 100, ppid: 1, startTimeMs: 1_000, cmd: 'codex app-server' },
            { pid: 101, ppid: 1, startTimeMs: 1_100 },
            { pid: 102, ppid: 101, startTimeMs: 1_200 },
            { pid: 103, ppid: 101, startTimeMs: 1_300 },
          ];
      return entries.filter((entry) => alive.has(entry.pid));
    });
    const terminated: number[] = [];
    const terminateWindowsTree = vi.fn((pid: number) => {
      terminated.push(pid);
      alive.delete(pid);
      if (pid === 102) {
        alive.add(103);
      }
    });
    let now = 0;
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => alive.has(pid)),
        platform: 'win32',
        terminateWindowsTree,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    } as any);

    await (boundary.terminateProcessTree as (timeoutMs: number) => Promise<void>)(100);

    expect(terminated).toEqual([102, 103, 101, 100]);
    expect(alive).toEqual(new Set());
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(false);
  });

  it('does not signal after process identity refresh consumes the absolute force deadline', async () => {
    let now = 0;
    let enumerations = 0;
    const listProcesses = vi.fn(async () => {
      enumerations += 1;
      if (enumerations > 1) now = 101;
      return [{
        pid: 100,
        ppid: 1,
        startTimeMs: 1_000,
        cmd: 'codex app-server',
      }];
    });
    const terminateWindowsTree = vi.fn();
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn(() => true),
        platform: 'win32',
        terminateWindowsTree,
        now: () => now,
        sleep: async () => undefined,
      },
    });

    await boundary.terminateProcessTree(100);

    expect(listProcesses).toHaveBeenCalledTimes(2);
    expect(terminateWindowsTree).not.toHaveBeenCalled();
  });

  it('never signals a tracked descendant pid after its start identity is reused', async () => {
    const alive = new Set([100, 101]);
    let enumerations = 0;
    const listProcesses = vi.fn(async () => {
      enumerations += 1;
      if (enumerations === 1) {
        return [
          { pid: 100, ppid: 1, startTimeMs: 1_000, cmd: 'codex app-server' },
          { pid: 101, ppid: 100, startTimeMs: 1_100 },
        ];
      }
      return [
        ...(alive.has(100)
          ? [{ pid: 100, ppid: 1, startTimeMs: 1_000, cmd: 'codex app-server' }]
          : []),
        ...(alive.has(101) ? [{ pid: 101, ppid: 1, startTimeMs: 9_900 }] : []),
      ];
    });
    const terminated: number[] = [];
    let now = 0;
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => alive.has(pid)),
        platform: 'win32',
        terminateWindowsTree: (pid: number) => {
          terminated.push(pid);
          alive.delete(pid);
        },
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    } as any);

    await (boundary.terminateProcessTree as (timeoutMs: number) => Promise<void>)(100);

    expect(terminated).toEqual([100]);
    expect(alive).toEqual(new Set([101]));
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(false);
  });

  it('does not treat a reused pid with a different start marker as original tree residue', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1, startTimeMs: 1_000 },
        { pid: 101, ppid: 100, startTimeMs: 1_100 },
      ])
      .mockResolvedValue([
        { pid: 101, ppid: 1, startTimeMs: 9_900 },
      ]);
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        isPidAlive: vi.fn((pid: number) => pid === 101),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(false);
  });

  it('persists start markers from the process identity reader when enumeration omits them', async () => {
    const listProcesses = vi.fn()
      .mockResolvedValueOnce([
        { pid: 100, ppid: 1 },
        { pid: 101, ppid: 100 },
      ])
      .mockResolvedValue([{ pid: 101, ppid: 1 }]);
    const markerReads = new Map<number, number>();
    const readProcessStartTimeMs = vi.fn(async (pid: number) => {
      const reads = (markerReads.get(pid) ?? 0) + 1;
      markerReads.set(pid, reads);
      if (pid === 100) return 1_000;
      if (pid === 101) return reads === 1 ? 1_100 : 9_900;
      return null;
    });
    const boundary = createCodexAppServerProcessDisposalBoundary({
      child: { pid: 100, stdin: { end: vi.fn() }, kill: vi.fn() } as any,
      closedPromise: Promise.resolve(),
      deps: {
        listProcesses,
        readProcessStartTimeMs,
        isPidAlive: vi.fn((pid: number) => pid === 101),
        platform: 'win32',
        terminateWindowsTree: vi.fn(),
      },
    });

    await boundary.terminateProcessTree(UNBOUNDED_TEST_DEADLINE_AT_MS);
    await expect(boundary.hasProcessTreeResidue()).resolves.toBe(false);
    expect(readProcessStartTimeMs).toHaveBeenCalledWith(101);
  });
});
