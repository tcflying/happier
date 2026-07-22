import { createDirectSessionViewerLeaseRegistry } from './directSessionViewerLeaseRegistry';

export type DirectSessionFollowLease = Readonly<{
  release: () => void | Promise<void>;
}>;

type ManagedFollowLeaseRecord = {
  sessionId: string;
  release: (() => void | Promise<void>) | null;
  acquireFollowLease: FollowLeaseAcquirer | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
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
  const backgroundFollowEnabledBySessionId = new Map<string, boolean>();
  const backgroundFollowAcquireBySessionId = new Map<string, FollowLeaseAcquirer>();
  const backgroundFollowLeasesBySessionId = new Map<string, ManagedFollowLeaseRecord>();
  const runtimeOwnedSinceBySessionId = new Map<string, number>();
  const retiredDirectFollowSessionIds = new Set<string>();

  const isRuntimeOwned = (sessionId: string): boolean => runtimeOwnedSinceBySessionId.has(sessionId);
  const isFollowFenced = (sessionId: string): boolean =>
    isRuntimeOwned(sessionId) || retiredDirectFollowSessionIds.has(sessionId);

  const releaseFollowLease = async (leaseId: string, sessionId: string): Promise<boolean> => {
    const record = followLeasesById.get(leaseId) ?? null;
    if (!record || record.sessionId !== sessionId) return false;
    followLeasesById.delete(leaseId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    await record.release?.();
    return true;
  };

  const suspendFollowLeaseForTakeover = async (leaseId: string, sessionId: string): Promise<boolean> => {
    const record = followLeasesById.get(leaseId) ?? null;
    if (!record || record.sessionId !== sessionId) return false;
    const release = record.release;
    record.release = null;
    await release?.();
    return true;
  };

  const releaseBackgroundFollowLease = async (sessionId: string): Promise<boolean> => {
    const record = backgroundFollowLeasesBySessionId.get(sessionId) ?? null;
    if (!record) return false;
    backgroundFollowLeasesBySessionId.delete(sessionId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    await record.release?.();
    return true;
  };

  const acquireDetachedBackgroundFollowLease = async (
    sessionId: string,
    acquireFollowLease: FollowLeaseAcquirer | null | undefined,
  ): Promise<boolean> => {
    if (isFollowFenced(sessionId)) {
      return false;
    }
    if (backgroundFollowLeasesBySessionId.has(sessionId)) {
      return false;
    }
    if (!acquireFollowLease) {
      return false;
    }
    const followLease = await acquireFollowLease();
    if (!followLease) {
      return false;
    }
    if (isFollowFenced(sessionId)) {
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
  };

  const handleNoActiveViewerLeases = async (sessionId: string): Promise<void> => {
    if (viewerLeaseRegistry.countActiveLeases(sessionId) > 0) {
      return;
    }
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
        await releaseFollowLease(leaseId, sessionId).catch(() => false);
        await handleNoActiveViewerLeases(sessionId);
      })();
    }, delayMs);
  };

  const reacquireReleasedViewerFollowLeases = async (sessionId: string): Promise<void> => {
    const records = Array.from(followLeasesById.values()).filter(
      (record) => record.sessionId === sessionId && !record.release && record.acquireFollowLease,
    );
    await Promise.all(records.map(async (record) => {
      const acquireFollowLease = record.acquireFollowLease;
      if (!acquireFollowLease || isFollowFenced(sessionId)) return;
      const followLease = await acquireFollowLease();
      if (!followLease) return;
      if (isFollowFenced(sessionId) || !Array.from(followLeasesById.values()).includes(record)) {
        await Promise.resolve(followLease.release()).catch(() => {});
        return;
      }
      record.release = followLease.release;
    }));
  };

  const clearRuntimeOwnership = async (sessionId: string): Promise<void> => {
    if (!runtimeOwnedSinceBySessionId.delete(sessionId)) return;
    await reacquireReleasedViewerFollowLeases(sessionId);
    await handleNoActiveViewerLeases(sessionId);
    // Persisted takeover permanently removes this session's Direct descriptor. Keep the
    // process-local tombstone so an attach that was authorized before conversion cannot
    // finish acquiring after the runtime exits and resurrect a stale follow stream.
  };

  const releaseForTakeover = async (sessionId: string) => {
    runtimeOwnedSinceBySessionId.set(sessionId, now());

    const viewerLeaseIds = Array.from(followLeasesById.entries())
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([leaseId]) => leaseId);
    const hadBackgroundFollowLease = backgroundFollowLeasesBySessionId.has(sessionId);

    await Promise.all(viewerLeaseIds.map(async (leaseId) => {
      await suspendFollowLeaseForTakeover(leaseId, sessionId).catch(() => false);
    }));
    await releaseBackgroundFollowLease(sessionId).catch(() => false);

    return {
      releasedViewerFollowLeases: viewerLeaseIds.length,
      releasedBackgroundFollowLease: hadBackgroundFollowLease,
    } as const;
  };

  const retireForPersistedTakeover = async (sessionId: string) => {
    retiredDirectFollowSessionIds.add(sessionId);
    runtimeOwnedSinceBySessionId.set(sessionId, now());

    const viewerLeaseIds = Array.from(followLeasesById.entries())
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([leaseId]) => leaseId);
    const hadBackgroundFollowLease = backgroundFollowLeasesBySessionId.has(sessionId);

    await Promise.all(viewerLeaseIds.map(async (leaseId) => {
      viewerLeaseRegistry.detach({ sessionId, leaseId });
      await releaseFollowLease(leaseId, sessionId).catch(() => false);
    }));
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
      const attached = viewerLeaseRegistry.attach({
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        ttlMs: input.ttlMs,
      });

      const existing = followLeasesById.get(attached.leaseId) ?? null;
      if (!attached.renewed) {
        try {
          const followLease = isFollowFenced(input.sessionId) || backgroundFollowLeasesBySessionId.has(input.sessionId)
            ? null
            : (await input.acquireFollowLease?.()) ?? null;
          const release = followLease && isFollowFenced(input.sessionId)
            ? null
            : followLease?.release ?? null;
          if (followLease && !release) {
            await Promise.resolve(followLease.release()).catch(() => {});
          }
          followLeasesById.set(attached.leaseId, {
            sessionId: input.sessionId,
            release,
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
          release: null,
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
      const detached = viewerLeaseRegistry.detach(input);
      if (detached.detached) {
        await releaseFollowLease(input.leaseId, input.sessionId).catch(() => false);
        await handleNoActiveViewerLeases(input.sessionId);
      }
      return detached;
    },

    releaseForTakeover,

    retireForPersistedTakeover,

    async setRuntimeOwned(sessionId: string, owned: boolean) {
      if (owned) {
        await releaseForTakeover(sessionId);
        return;
      }
      await clearRuntimeOwnership(sessionId);
    },

    async reconcileRuntimeOwnership(sessionId: string, runnerActive: boolean) {
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
  };
}

export type DirectSessionFollowLeaseManager = ReturnType<typeof createDirectSessionFollowLeaseManager>;
