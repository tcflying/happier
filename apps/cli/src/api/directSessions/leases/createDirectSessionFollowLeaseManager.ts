import { createDirectSessionViewerLeaseRegistry } from './directSessionViewerLeaseRegistry';

export type DirectSessionFollowLease = Readonly<{
  release: () => void | Promise<void>;
}>;

type ManagedFollowLeaseRecord = {
  sessionId: string;
  acquireFollowLease: FollowLeaseAcquirer | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

type ManagedBackgroundFollowLeaseRecord = ManagedFollowLeaseRecord & {
  release: () => void | Promise<void>;
};

type SharedViewerFollowLeaseRecord = {
  release: () => void | Promise<void>;
  acquireFollowLease: FollowLeaseAcquirer;
};

type DirectSessionFollowLeaseManagerParams = Readonly<{
  now?: () => number;
  randomId?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

type FollowLeaseAcquirer = () => Promise<DirectSessionFollowLease | null>;

const RUNTIME_OWNERSHIP_STARTUP_GRACE_MS = 10_000;

function clearManagedTimer(
  timer: ReturnType<typeof setTimeout> | null,
  clearTimer: typeof clearTimeout,
): void {
  if (timer) {
    clearTimer(timer);
  }
}

export function createDirectSessionFollowLeaseManager(params?: DirectSessionFollowLeaseManagerParams) {
  const now = params?.now ?? Date.now;
  const setTimer = params?.setTimer ?? setTimeout;
  const clearTimer = params?.clearTimer ?? clearTimeout;
  const viewerLeaseRegistry = createDirectSessionViewerLeaseRegistry({
    now,
    randomId: params?.randomId,
  });
  const followLeasesById = new Map<string, ManagedFollowLeaseRecord>();
  const viewerFollowLeasesBySessionId = new Map<string, SharedViewerFollowLeaseRecord>();
  const viewerFollowAcquireBySessionId = new Map<string, Promise<DirectSessionFollowLease | null>>();
  const backgroundFollowEnabledBySessionId = new Map<string, boolean>();
  const backgroundFollowAcquireBySessionId = new Map<string, FollowLeaseAcquirer>();
  const backgroundFollowLeasesBySessionId = new Map<string, ManagedBackgroundFollowLeaseRecord>();
  const backgroundFollowAcquireInFlightBySessionId = new Map<string, Promise<boolean>>();
  const runtimeOwnedSinceBySessionId = new Map<string, number>();
  const takeoverFenceTokenBySessionId = new Map<string, string>();
  const retiredDirectFollowSessionIds = new Set<string>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let nextTakeoverFenceId = 0;

  const isRuntimeOwned = (sessionId: string): boolean => runtimeOwnedSinceBySessionId.has(sessionId);
  const isFollowFenced = (sessionId: string): boolean =>
    isRuntimeOwned(sessionId) || retiredDirectFollowSessionIds.has(sessionId);

  const deleteViewerLeaseRecord = (leaseId: string, sessionId: string): boolean => {
    const record = followLeasesById.get(leaseId) ?? null;
    if (!record || record.sessionId !== sessionId) return false;
    followLeasesById.delete(leaseId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    return true;
  };

  const releaseSharedViewerFollowLease = async (sessionId: string): Promise<boolean> => {
    const shared = viewerFollowLeasesBySessionId.get(sessionId) ?? null;
    if (!shared) return false;
    viewerFollowLeasesBySessionId.delete(sessionId);
    await shared.release();
    return true;
  };

  const acquireSharedViewerFollowLease = async (
    sessionId: string,
    acquireFollowLease: FollowLeaseAcquirer,
  ): Promise<boolean> => {
    if (disposed || isFollowFenced(sessionId) || backgroundFollowLeasesBySessionId.has(sessionId)) {
      return false;
    }
    if (viewerFollowLeasesBySessionId.has(sessionId)) {
      return false;
    }

    const existingAcquire = viewerFollowAcquireBySessionId.get(sessionId);
    if (existingAcquire) {
      await existingAcquire;
      return viewerFollowLeasesBySessionId.has(sessionId);
    }
    const acquisition = Promise.resolve().then(acquireFollowLease);
    viewerFollowAcquireBySessionId.set(sessionId, acquisition);

    let followLease: DirectSessionFollowLease | null;
    try {
      followLease = await acquisition;
    } finally {
      if (viewerFollowAcquireBySessionId.get(sessionId) === acquisition) {
        viewerFollowAcquireBySessionId.delete(sessionId);
      }
    }
    if (!followLease) return false;

    if (
      disposed
      || isFollowFenced(sessionId)
      || backgroundFollowLeasesBySessionId.has(sessionId)
      || viewerLeaseRegistry.countActiveLeases(sessionId) === 0
    ) {
      await Promise.resolve(followLease.release()).catch(() => {});
      return false;
    }
    if (viewerFollowLeasesBySessionId.has(sessionId)) {
      await Promise.resolve(followLease.release()).catch(() => {});
      return false;
    }
    viewerFollowLeasesBySessionId.set(sessionId, {
      release: followLease.release,
      acquireFollowLease,
    });
    return true;
  };

  const releaseBackgroundFollowLease = async (sessionId: string): Promise<boolean> => {
    const record = backgroundFollowLeasesBySessionId.get(sessionId) ?? null;
    if (!record) return false;
    backgroundFollowLeasesBySessionId.delete(sessionId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    await record.release();
    return true;
  };

  const acquireDetachedBackgroundFollowLease = async (
    sessionId: string,
    acquireFollowLease: FollowLeaseAcquirer | null | undefined,
  ): Promise<boolean> => {
    if (disposed || isFollowFenced(sessionId)) {
      return false;
    }
    if (backgroundFollowLeasesBySessionId.has(sessionId)) {
      return false;
    }
    if (!acquireFollowLease) {
      return false;
    }
    const existingAcquire = backgroundFollowAcquireInFlightBySessionId.get(sessionId);
    if (existingAcquire) {
      return await existingAcquire;
    }

    const acquisition = (async (): Promise<boolean> => {
      const followLease = await acquireFollowLease();
      if (!followLease) {
        return false;
      }
      if (
        disposed
        || isFollowFenced(sessionId)
        || backgroundFollowLeasesBySessionId.has(sessionId)
        || viewerLeaseRegistry.countActiveLeases(sessionId) > 0
        || backgroundFollowEnabledBySessionId.get(sessionId) !== true
        || backgroundFollowAcquireBySessionId.get(sessionId) !== acquireFollowLease
      ) {
        await Promise.resolve(followLease.release()).catch(() => {});
        return false;
      }
      backgroundFollowLeasesBySessionId.set(sessionId, {
        sessionId,
        release: followLease.release,
        acquireFollowLease,
        expiryTimer: null,
      });
      return true;
    })();
    backgroundFollowAcquireInFlightBySessionId.set(sessionId, acquisition);
    try {
      return await acquisition;
    } finally {
      if (backgroundFollowAcquireInFlightBySessionId.get(sessionId) === acquisition) {
        backgroundFollowAcquireInFlightBySessionId.delete(sessionId);
      }
    }
  };

  const handleNoActiveViewerLeases = async (sessionId: string): Promise<void> => {
    if (disposed) {
      return;
    }
    if (viewerLeaseRegistry.countActiveLeases(sessionId) > 0) {
      return;
    }
    await releaseSharedViewerFollowLease(sessionId);
    if (backgroundFollowEnabledBySessionId.get(sessionId) === true) {
      if (isFollowFenced(sessionId)) {
        return;
      }
      const acquireFollowLease = backgroundFollowAcquireBySessionId.get(sessionId) ?? null;
      if (acquireFollowLease) {
        await acquireDetachedBackgroundFollowLease(sessionId, acquireFollowLease).catch(() => false);
      }
      return;
    }
    await releaseBackgroundFollowLease(sessionId);
  };

  const scheduleExpiry = (leaseId: string, sessionId: string, expiresAtMs: number): void => {
    const record = followLeasesById.get(leaseId);
    if (!record || record.sessionId !== sessionId) return;
    clearManagedTimer(record.expiryTimer, clearTimer);
    const delayMs = Math.max(0, expiresAtMs - now());
    record.expiryTimer = setTimer(() => {
      void (async () => {
        viewerLeaseRegistry.detach({ sessionId, leaseId });
        deleteViewerLeaseRecord(leaseId, sessionId);
        await handleNoActiveViewerLeases(sessionId);
      })();
    }, delayMs);
  };

  const reacquireReleasedViewerFollowLeases = async (sessionId: string): Promise<void> => {
    if (
      disposed
      || isFollowFenced(sessionId)
      || viewerFollowLeasesBySessionId.has(sessionId)
      || backgroundFollowLeasesBySessionId.has(sessionId)
      || viewerLeaseRegistry.countActiveLeases(sessionId) === 0
    ) return;
    const record = Array.from(followLeasesById.values()).find(
      (candidate) => candidate.sessionId === sessionId && candidate.acquireFollowLease,
    );
    if (!record?.acquireFollowLease) return;
    await acquireSharedViewerFollowLease(sessionId, record.acquireFollowLease);
  };

  const clearRuntimeOwnership = async (sessionId: string): Promise<void> => {
    if (disposed) return;
    if (!runtimeOwnedSinceBySessionId.delete(sessionId)) return;
    await reacquireReleasedViewerFollowLeases(sessionId);
    await handleNoActiveViewerLeases(sessionId);
    // Persisted takeover permanently removes this session's Direct descriptor. Keep the
    // process-local tombstone so an attach that was authorized before conversion cannot
    // finish acquiring after the runtime exits and resurrect a stale follow stream.
  };

  const releaseActiveFollowLeasesForTakeover = async (sessionId: string) => {
    const viewerLeaseIds = Array.from(followLeasesById.entries())
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([leaseId]) => leaseId);
    const hadBackgroundFollowLease = backgroundFollowLeasesBySessionId.has(sessionId);

    await releaseSharedViewerFollowLease(sessionId).catch(() => false);
    await releaseBackgroundFollowLease(sessionId).catch(() => false);

    return {
      releasedViewerFollowLeases: viewerLeaseIds.length,
      releasedBackgroundFollowLease: hadBackgroundFollowLease,
    } as const;
  };

  const releaseForTakeover = async (sessionId: string) => {
    runtimeOwnedSinceBySessionId.set(sessionId, now());
    return await releaseActiveFollowLeasesForTakeover(sessionId);
  };

  const beginTakeoverFence = async (sessionId: string) => {
    if (disposed || isRuntimeOwned(sessionId) || takeoverFenceTokenBySessionId.has(sessionId)) {
      return null;
    }
    const token = `direct-takeover-${params?.randomId?.() ?? 'lease'}-${++nextTakeoverFenceId}`;
    takeoverFenceTokenBySessionId.set(sessionId, token);
    runtimeOwnedSinceBySessionId.set(sessionId, now());
    const released = await releaseActiveFollowLeasesForTakeover(sessionId);
    return { token, ...released } as const;
  };

  const commitTakeoverFence = (sessionId: string, token: string): boolean => {
    if (takeoverFenceTokenBySessionId.get(sessionId) !== token) {
      return false;
    }
    takeoverFenceTokenBySessionId.delete(sessionId);
    return true;
  };

  const rollbackTakeoverFence = async (sessionId: string, token: string): Promise<boolean> => {
    if (takeoverFenceTokenBySessionId.get(sessionId) !== token) {
      return false;
    }
    takeoverFenceTokenBySessionId.delete(sessionId);
    await clearRuntimeOwnership(sessionId);
    return true;
  };

  const retireForPersistedTakeover = async (sessionId: string) => {
    retiredDirectFollowSessionIds.add(sessionId);
    takeoverFenceTokenBySessionId.delete(sessionId);
    runtimeOwnedSinceBySessionId.set(sessionId, now());

    const viewerLeaseIds = Array.from(followLeasesById.entries())
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([leaseId]) => leaseId);
    const hadBackgroundFollowLease = backgroundFollowLeasesBySessionId.has(sessionId);

    for (const leaseId of viewerLeaseIds) {
      viewerLeaseRegistry.detach({ sessionId, leaseId });
      deleteViewerLeaseRecord(leaseId, sessionId);
    }
    await releaseSharedViewerFollowLease(sessionId).catch(() => false);
    backgroundFollowEnabledBySessionId.delete(sessionId);
    backgroundFollowAcquireBySessionId.delete(sessionId);
    await releaseBackgroundFollowLease(sessionId).catch(() => false);

    return {
      releasedViewerFollowLeases: viewerLeaseIds.length,
      releasedBackgroundFollowLease: hadBackgroundFollowLease,
    } as const;
  };

  return {
    async attach(input: Readonly<{
      sessionId: string;
      leaseId?: string | null;
      ttlMs: number;
      acquireFollowLease?: FollowLeaseAcquirer;
    }>) {
      if (disposed) {
        throw new Error('Direct session follow lease manager is disposed');
      }
      const attached = viewerLeaseRegistry.attach({
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        ttlMs: input.ttlMs,
      });

      const existing = followLeasesById.get(attached.leaseId) ?? null;
      if (!attached.renewed) {
        try {
          if (
            input.acquireFollowLease
            && !retiredDirectFollowSessionIds.has(input.sessionId)
            && !isFollowFenced(input.sessionId)
            && !backgroundFollowLeasesBySessionId.has(input.sessionId)
          ) {
            await acquireSharedViewerFollowLease(input.sessionId, input.acquireFollowLease);
          }
          followLeasesById.set(attached.leaseId, {
            sessionId: input.sessionId,
            acquireFollowLease: retiredDirectFollowSessionIds.has(input.sessionId)
              ? null
              : input.acquireFollowLease ?? null,
            expiryTimer: null,
          });
        } catch (error) {
          viewerLeaseRegistry.detach({
            sessionId: input.sessionId,
            leaseId: attached.leaseId,
          });
          throw error;
        }
      } else if (!existing) {
        followLeasesById.set(attached.leaseId, {
          sessionId: input.sessionId,
          acquireFollowLease: retiredDirectFollowSessionIds.has(input.sessionId)
            ? null
            : input.acquireFollowLease ?? null,
          expiryTimer: null,
        });
      } else if (input.acquireFollowLease && !retiredDirectFollowSessionIds.has(input.sessionId)) {
        existing.acquireFollowLease = input.acquireFollowLease;
      }

      scheduleExpiry(attached.leaseId, input.sessionId, attached.expiresAtMs);
      return attached;
    },

    async detach(input: Readonly<{ sessionId: string; leaseId: string }>) {
      if (disposed) {
        return { detached: false } as const;
      }
      const detached = viewerLeaseRegistry.detach(input);
      if (detached.detached) {
        deleteViewerLeaseRecord(input.leaseId, input.sessionId);
        await handleNoActiveViewerLeases(input.sessionId);
      }
      return detached;
    },

    releaseForTakeover,

    beginTakeoverFence,

    commitTakeoverFence,

    rollbackTakeoverFence,

    retireForPersistedTakeover,

    async setRuntimeOwned(sessionId: string, owned: boolean) {
      if (owned) {
        await releaseForTakeover(sessionId);
        return;
      }
      await clearRuntimeOwnership(sessionId);
    },

    async reconcileRuntimeOwnership(sessionId: string, runnerActive: boolean) {
      if (takeoverFenceTokenBySessionId.has(sessionId)) {
        return;
      }
      if (runnerActive) {
        if (!isRuntimeOwned(sessionId)) {
          await releaseForTakeover(sessionId);
        }
        return;
      }
      const ownedSince = runtimeOwnedSinceBySessionId.get(sessionId);
      if (ownedSince !== undefined && now() - ownedSince >= RUNTIME_OWNERSHIP_STARTUP_GRACE_MS) {
        await clearRuntimeOwnership(sessionId);
      }
    },

    async setBackgroundFollowEnabled(input: Readonly<{
      sessionId: string;
      enabled: boolean;
      acquireFollowLease?: FollowLeaseAcquirer;
    }>) {
      if (disposed) {
        return { enabled: false, leaseAcquired: false } as const;
      }
      if (retiredDirectFollowSessionIds.has(input.sessionId)) {
        backgroundFollowEnabledBySessionId.delete(input.sessionId);
        backgroundFollowAcquireBySessionId.delete(input.sessionId);
        await releaseBackgroundFollowLease(input.sessionId).catch(() => false);
        return { enabled: false, leaseAcquired: false } as const;
      }
      backgroundFollowEnabledBySessionId.set(input.sessionId, input.enabled);

      if (!input.enabled) {
        backgroundFollowAcquireBySessionId.delete(input.sessionId);
        if (viewerLeaseRegistry.countActiveLeases(input.sessionId) === 0) {
          await releaseBackgroundFollowLease(input.sessionId).catch(() => false);
        }
        return { enabled: false, leaseAcquired: false } as const;
      }

      if (input.acquireFollowLease) {
        backgroundFollowAcquireBySessionId.set(input.sessionId, input.acquireFollowLease);
      }

      if (backgroundFollowLeasesBySessionId.has(input.sessionId)) {
        return { enabled: true, leaseAcquired: false } as const;
      }

      if (viewerLeaseRegistry.countActiveLeases(input.sessionId) > 0) {
        return { enabled: true, leaseAcquired: false } as const;
      }

      const acquireFollowLease =
        input.acquireFollowLease ?? backgroundFollowAcquireBySessionId.get(input.sessionId) ?? null;
      if (!acquireFollowLease) {
        return { enabled: true, leaseAcquired: false } as const;
      }
      const leaseAcquired = await acquireDetachedBackgroundFollowLease(input.sessionId, acquireFollowLease);
      return { enabled: true, leaseAcquired } as const;
    },

    countActiveLeases(sessionId: string): number {
      return viewerLeaseRegistry.countActiveLeases(sessionId);
    },

    isBackgroundFollowEnabled(sessionId: string): boolean {
      return backgroundFollowEnabledBySessionId.get(sessionId) ?? false;
    },

    hasBackgroundFollowLease(sessionId: string): boolean {
      return backgroundFollowLeasesBySessionId.has(sessionId);
    },

    async dispose(): Promise<void> {
      if (disposePromise) {
        return await disposePromise;
      }
      disposed = true;
      disposePromise = (async () => {
        for (const record of followLeasesById.values()) {
          clearManagedTimer(record.expiryTimer, clearTimer);
        }
        followLeasesById.clear();
        viewerLeaseRegistry.clear();
        backgroundFollowEnabledBySessionId.clear();
        backgroundFollowAcquireBySessionId.clear();
        runtimeOwnedSinceBySessionId.clear();
        takeoverFenceTokenBySessionId.clear();
        retiredDirectFollowSessionIds.clear();

        const activeReleases = [
          ...Array.from(viewerFollowLeasesBySessionId.values(), (record) => record.release),
          ...Array.from(backgroundFollowLeasesBySessionId.values(), (record) => {
            clearManagedTimer(record.expiryTimer, clearTimer);
            return record.release;
          }),
        ];
        viewerFollowLeasesBySessionId.clear();
        backgroundFollowLeasesBySessionId.clear();

        // An acquisition can wait indefinitely on a provider. Do not let that block machine
        // shutdown: the disposed guard above makes every late result release itself instead of
        // becoming active.
        viewerFollowAcquireBySessionId.clear();
        backgroundFollowAcquireInFlightBySessionId.clear();
        await Promise.allSettled(activeReleases.map(async (release) => await release()));
      })();
      return await disposePromise;
    },
  };
}

export type DirectSessionFollowLeaseManager = ReturnType<typeof createDirectSessionFollowLeaseManager>;
