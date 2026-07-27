import { spawnSync, type ChildProcess } from 'node:child_process';

import psList from 'ps-list';

import { killProcessTree } from '@/agent/acp/killProcessTree';
import {
  readProcessCommandIdentity as readProcessCommandIdentityDefault,
  readProcessStartTimeMs as readProcessStartTimeMsDefault,
} from '@/daemon/processStartTime';

export type CodexAppServerProcessDisposalBoundary = Readonly<{
  requestGracefulStop: () => void;
  waitForExit: () => Promise<void>;
  terminateProcessTree: (forceDeadlineAtMs: number) => Promise<void>;
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

  const forceDeadlineAtMs = Date.now() + Math.max(0, options.forceTimeoutMs);
  await boundary.terminateProcessTree(forceDeadlineAtMs);
  const remainingForceMs = forceDeadlineAtMs - Date.now();
  if (remainingForceMs > 0) {
    await settlesWithin(exitPromise, remainingForceMs);
  }
  const processTreeResidue = await boundary.hasProcessTreeResidue();
  if (processTreeResidue) {
    throw new Error('Codex app-server process tree residue remained after forced cleanup');
  }
  return { outcome: 'forced', processTreeResidue: false };
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ProcessTreeEntry = Readonly<{
  pid: number;
  ppid: number;
  name?: string;
  cmd?: string;
  startTimeMs?: number;
}>;

function normalizeProcessCommandIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function collectProcessTreePids(
  rootPid: number,
  alreadyTracked: ReadonlyMap<number, number | null>,
  trackedCommandIdentities: ReadonlyMap<number, string | null>,
  processes: readonly ProcessTreeEntry[],
): readonly number[] {
  const processesByPid = new Map<number, ProcessTreeEntry>();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of processes) {
    if (!Number.isInteger(entry.pid) || !Number.isInteger(entry.ppid)) continue;
    processesByPid.set(entry.pid, entry);
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }

  const discovered = new Set<number>();
  const visited = new Set<number>();
  const startMarkerFor = (pid: number): number | null => {
    const marker = processesByPid.get(pid)?.startTimeMs;
    return typeof marker === 'number' && Number.isFinite(marker) && marker > 0
      ? Math.floor(marker)
      : null;
  };
  const provesPidReuse = (pid: number): boolean => {
    if (!alreadyTracked.has(pid)) return false;
    const stored = alreadyTracked.get(pid) ?? null;
    const current = startMarkerFor(pid);
    if (stored !== null && current !== null && stored !== current) return true;
    const storedCommand = trackedCommandIdentities.get(pid) ?? null;
    const currentCommand = normalizeProcessCommandIdentity(processesByPid.get(pid)?.cmd);
    return storedCommand !== null
      && currentCommand !== null
      && storedCommand !== currentCommand;
  };
  const visit = (pid: number) => {
    if (visited.has(pid)) return;
    visited.add(pid);
    if (provesPidReuse(pid)) return;
    discovered.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
  };
  for (const seedPid of new Set<number>([rootPid, ...alreadyTracked.keys()])) {
    visit(seedPid);
  }
  return [...discovered];
}

export function createCodexAppServerProcessDisposalBoundary(params: Readonly<{
  child: ChildProcess;
  closedPromise: Promise<void>;
  deps?: Readonly<{
    listProcesses?: () => Promise<readonly ProcessTreeEntry[]>;
    isPidAlive?: (pid: number) => boolean;
    readProcessStartTimeMs?: (pid: number) => Promise<number | null> | number | null;
    readProcessCommandIdentity?: (pid: number) => Promise<string | null> | string | null;
    platform?: NodeJS.Platform;
    terminateWindowsTree?: (rootPid: number) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }>;
}>): CodexAppServerProcessDisposalBoundary {
  const rootPid = params.child.pid ?? null;
  const listProcesses: () => Promise<readonly ProcessTreeEntry[]> =
    params.deps?.listProcesses ?? psList;
  const isPidAlive = params.deps?.isPidAlive ?? isPidAliveDefault;
  const platform = params.deps?.platform ?? process.platform;
  const readProcessStartTimeMs = params.deps?.readProcessStartTimeMs
    ?? ((pid: number) => readProcessStartTimeMsDefault(pid, platform));
  const readProcessCommandIdentity = params.deps?.readProcessCommandIdentity
    ?? (params.deps?.listProcesses
      ? (() => null)
      : ((pid: number) => readProcessCommandIdentityDefault(pid, platform)));
  const terminateWindowsTree = params.deps?.terminateWindowsTree ?? ((pid: number) => {
    spawnSync('taskkill', ['/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  });
  const now = params.deps?.now ?? Date.now;
  const sleep = params.deps?.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
  });
  const trackedProcessStartMarkers = new Map<number, number | null>();
  const trackedProcessCommandIdentities = new Map<number, string | null>();
  const trackedProcessParentPids = new Map<number, number>();
  let lastEnumeratedProcesses = new Map<number, ProcessTreeEntry>();
  let enumerationHealthy = rootPid === null;
  const refreshTrackedPids = async (): Promise<boolean> => {
    if (!rootPid) return true;
    try {
      const enumeratedProcesses = await listProcesses();
      const initialDiscoveredPids = collectProcessTreePids(
        rootPid,
        trackedProcessStartMarkers,
        trackedProcessCommandIdentities,
        enumeratedProcesses,
      );
      const processStartMarkers = new Map<number, number | null>();
      await Promise.all(initialDiscoveredPids.map(async (pid) => {
        const entry = enumeratedProcesses.find((candidate) => candidate.pid === pid);
        if (!entry) return;
        const inlineMarker = entry.startTimeMs;
        if (typeof inlineMarker === 'number' && Number.isFinite(inlineMarker) && inlineMarker > 0) {
          processStartMarkers.set(pid, Math.floor(inlineMarker));
          return;
        }
        const inspectedMarker = await Promise.resolve(readProcessStartTimeMs(pid)).catch(() => null);
        processStartMarkers.set(
          pid,
          typeof inspectedMarker === 'number' && Number.isFinite(inspectedMarker) && inspectedMarker > 0
            ? Math.floor(inspectedMarker)
          : null,
        );
      }));
      const enumeratedRoot = enumeratedProcesses.find((entry) => entry.pid === rootPid);
      const inlineRootCommand = normalizeProcessCommandIdentity(enumeratedRoot?.cmd);
      const inspectedRootCommand = enumeratedRoot && inlineRootCommand === null
        ? normalizeProcessCommandIdentity(
          await Promise.resolve(readProcessCommandIdentity(rootPid)).catch(() => null),
        )
        : inlineRootCommand;
      const processes = enumeratedProcesses.map((entry) => {
        const marker = processStartMarkers.get(entry.pid);
        return {
          ...entry,
          ...(marker === undefined || marker === null ? {} : { startTimeMs: marker }),
          ...(entry.pid === rootPid && inspectedRootCommand
            ? { cmd: inspectedRootCommand }
            : {}),
        };
      });
      lastEnumeratedProcesses = new Map(
        processes
          .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
          .map((entry) => [entry.pid, entry]),
      );
      for (const pid of collectProcessTreePids(
        rootPid,
        trackedProcessStartMarkers,
        trackedProcessCommandIdentities,
        processes,
      )) {
        if (trackedProcessStartMarkers.has(pid)) continue;
        const marker = processStartMarkers.get(pid) ?? lastEnumeratedProcesses.get(pid)?.startTimeMs;
        trackedProcessStartMarkers.set(
          pid,
          typeof marker === 'number' && Number.isFinite(marker) && marker > 0
            ? Math.floor(marker)
            : null,
        );
        trackedProcessCommandIdentities.set(
          pid,
          normalizeProcessCommandIdentity(lastEnumeratedProcesses.get(pid)?.cmd),
        );
        const parentPid = lastEnumeratedProcesses.get(pid)?.ppid;
        if (typeof parentPid === 'number' && Number.isInteger(parentPid)) {
          trackedProcessParentPids.set(pid, parentPid);
        }
      }
      enumerationHealthy = true;
      return true;
    } catch {
      enumerationHealthy = false;
      return false;
    }
  };
  const initialSnapshot = refreshTrackedPids();

  const listVerifiedAlivePidsDescendantsFirst = (): readonly number[] => {
    const candidates: number[] = [];
    for (const [pid, originalStartMarker] of trackedProcessStartMarkers) {
      if (originalStartMarker === null) continue;
      const currentStartMarkerRaw = lastEnumeratedProcesses.get(pid)?.startTimeMs;
      const currentStartMarker = typeof currentStartMarkerRaw === 'number'
        && Number.isFinite(currentStartMarkerRaw)
        && currentStartMarkerRaw > 0
        ? Math.floor(currentStartMarkerRaw)
        : null;
      if (currentStartMarker !== originalStartMarker) continue;
      if (pid === rootPid) {
        const originalCommand = trackedProcessCommandIdentities.get(pid) ?? null;
        const currentCommand = normalizeProcessCommandIdentity(
          lastEnumeratedProcesses.get(pid)?.cmd,
        );
        if (originalCommand === null || currentCommand !== originalCommand) continue;
      }
      try {
        if (isPidAlive(pid)) candidates.push(pid);
      } catch {
        // An unreadable liveness state is not safe enough to authorize a signal.
      }
    }
    const candidateSet = new Set(candidates);
    const depthMemo = new Map<number, number>();
    const depthOf = (pid: number, visiting = new Set<number>()): number => {
      const memoized = depthMemo.get(pid);
      if (memoized !== undefined) return memoized;
      if (visiting.has(pid)) return 0;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(pid);
      const parentPid = trackedProcessParentPids.get(pid);
      const depth = parentPid !== undefined && candidateSet.has(parentPid)
        ? depthOf(parentPid, nextVisiting) + 1
        : 0;
      depthMemo.set(pid, depth);
      return depth;
    };
    return candidates.sort((left, right) => {
      const depthDifference = depthOf(right) - depthOf(left);
      if (depthDifference !== 0) return depthDifference;
      return right - left;
    });
  };

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
    terminateProcessTree: async (forceDeadlineAtMs: number) => {
      if (!rootPid) return;
      await initialSnapshot;
      if (platform === 'win32') {
        const deadline = Number.isFinite(forceDeadlineAtMs)
          ? Math.max(0, forceDeadlineAtMs)
          : now();
        if (now() > deadline) return;
        do {
          const refreshed = await refreshTrackedPids();
          if (!refreshed || !enumerationHealthy) return;
          if (now() > deadline) return;
          const [nextPid] = listVerifiedAlivePidsDescendantsFirst();
          if (nextPid === undefined) return;
          if (now() > deadline) return;
          terminateWindowsTree(nextPid);
          const remainingMs = deadline - now();
          if (remainingMs <= 0) return;
          await sleep(Math.min(10, remainingMs));
        } while (now() <= deadline);
        return;
      }
      await refreshTrackedPids();
      await killProcessTree(params.child, { graceMs: 250 });
    },
    hasProcessTreeResidue: async () => {
      await initialSnapshot;
      const refreshed = await refreshTrackedPids();
      if (!refreshed || !enumerationHealthy) return true;
      return [...trackedProcessStartMarkers].some(([pid, storedStartMarker]) => {
        const currentStartMarkerRaw = lastEnumeratedProcesses.get(pid)?.startTimeMs;
        const currentStartMarker = typeof currentStartMarkerRaw === 'number'
          && Number.isFinite(currentStartMarkerRaw)
          && currentStartMarkerRaw > 0
          ? Math.floor(currentStartMarkerRaw)
          : null;
        if (
          storedStartMarker !== null
          && currentStartMarker !== null
          && storedStartMarker !== currentStartMarker
        ) {
          return false;
        }
        if (pid === rootPid) {
          const storedCommand = trackedProcessCommandIdentities.get(pid) ?? null;
          const currentCommand = normalizeProcessCommandIdentity(
            lastEnumeratedProcesses.get(pid)?.cmd,
          );
          if (
            storedCommand !== null
            && currentCommand !== null
            && storedCommand !== currentCommand
          ) {
            return false;
          }
        }
        try {
          return isPidAlive(pid);
        } catch {
          return true;
        }
      });
    },
  };
}
