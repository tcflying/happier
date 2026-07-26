import { spawnSync, type ChildProcess } from 'node:child_process';

import psList from 'ps-list';

import { killProcessTree } from '@/agent/acp/killProcessTree';

export type CodexAppServerProcessDisposalBoundary = Readonly<{
  requestGracefulStop: () => void;
  waitForExit: () => Promise<void>;
  terminateProcessTree: () => Promise<void>;
  hasProcessTreeResidue: () => Promise<boolean>;
}>;

export type CodexAppServerProcessDisposalResult = Readonly<{
  outcome: 'graceful' | 'forced';
  processTreeResidue: false;
}>;

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export async function disposeCodexAppServerProcess(
  boundary: CodexAppServerProcessDisposalBoundary,
  options: Readonly<{
    gracefulTimeoutMs: number;
    forceTimeoutMs: number;
  }>,
): Promise<CodexAppServerProcessDisposalResult> {
  boundary.requestGracefulStop();
  const exitPromise = boundary.waitForExit();
  const exitedGracefully = await settlesWithin(exitPromise, options.gracefulTimeoutMs);
  const gracefulResidue = exitedGracefully
    ? await boundary.hasProcessTreeResidue()
    : true;
  if (exitedGracefully && !gracefulResidue) {
    return { outcome: 'graceful', processTreeResidue: false };
  }

  await boundary.terminateProcessTree();
  await settlesWithin(exitPromise, options.forceTimeoutMs);
  const processTreeResidue = await boundary.hasProcessTreeResidue();
  if (processTreeResidue) {
    throw new Error('Codex app-server process tree residue remained after forced cleanup');
  }
  return { outcome: 'forced', processTreeResidue: false };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function snapshotProcessTreePids(rootPid: number): Promise<readonly number[]> {
  const processes = await psList();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of processes) {
    if (!Number.isInteger(entry.pid) || !Number.isInteger(entry.ppid)) continue;
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }

  const pids = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (pids.has(childPid)) continue;
      pids.add(childPid);
      visit(childPid);
    }
  };
  visit(rootPid);
  return [...pids];
}

export function createCodexAppServerProcessDisposalBoundary(params: Readonly<{
  child: ChildProcess;
  closedPromise: Promise<void>;
}>): CodexAppServerProcessDisposalBoundary {
  const rootPid = params.child.pid ?? null;
  const trackedPidsPromise = rootPid
    ? snapshotProcessTreePids(rootPid).catch(() => [rootPid] as const)
    : Promise.resolve([] as const);

  return {
    requestGracefulStop: () => {
      try {
        params.child.stdin?.end();
      } catch {
        // Best effort: process termination below remains authoritative.
      }
      try {
        params.child.kill();
      } catch {
        // A bounded process-tree termination follows when close is not observed.
      }
    },
    waitForExit: async () => await params.closedPromise,
    terminateProcessTree: async () => {
      if (!rootPid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(rootPid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return;
      }
      await killProcessTree(params.child, { graceMs: 250 });
    },
    hasProcessTreeResidue: async () => {
      const trackedPids = await trackedPidsPromise;
      return trackedPids.some(isPidAlive);
    },
  };
}
