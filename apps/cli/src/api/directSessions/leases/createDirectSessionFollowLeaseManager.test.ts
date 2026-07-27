import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDirectSessionFollowLeaseManager,
  type DirectSessionFollowLease,
} from './createDirectSessionFollowLeaseManager';

describe('createDirectSessionFollowLeaseManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires one follow lease for a viewer lease, renews its expiry, and releases it on detach', async () => {
    let nowMs = 1_000;
    const release = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(async () => ({ release }));

    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-1',
    });

    const attached = await manager.attach({
      sessionId: 'session-1',
      ttlMs: 30_000,
      acquireFollowLease,
    });

    expect(attached).toEqual({
      leaseId: 'lease-1',
      expiresAtMs: 31_000,
      renewed: false,
    });
    expect(acquireFollowLease).toHaveBeenCalledTimes(1);

    nowMs = 10_000;
    const renewed = await manager.attach({
      sessionId: 'session-1',
      leaseId: 'lease-1',
      ttlMs: 30_000,
      acquireFollowLease,
    });

    expect(renewed).toEqual({
      leaseId: 'lease-1',
      expiresAtMs: 40_000,
      renewed: true,
    });
    expect(acquireFollowLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(release).not.toHaveBeenCalled();

    const detached = await manager.detach({
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });

    expect(detached).toEqual({ detached: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('shares one provider follow stream across viewers and releases it only after the last detach', async () => {
    const sharedRelease = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(async () => ({ release: sharedRelease }));
    let leaseIndex = 0;
    const manager = createDirectSessionFollowLeaseManager({
      randomId: () => `lease-shared-${++leaseIndex}`,
    });

    const first = await manager.attach({
      sessionId: 'session-shared-viewers',
      ttlMs: 30_000,
      acquireFollowLease,
    });
    const second = await manager.attach({
      sessionId: 'session-shared-viewers',
      ttlMs: 30_000,
      acquireFollowLease,
    });

    expect(acquireFollowLease).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-shared-viewers')).toBe(2);

    await manager.detach({
      sessionId: 'session-shared-viewers',
      leaseId: first.leaseId,
    });
    expect(sharedRelease).not.toHaveBeenCalled();
    expect(manager.countActiveLeases('session-shared-viewers')).toBe(1);

    await manager.detach({
      sessionId: 'session-shared-viewers',
      leaseId: second.leaseId,
    });
    expect(sharedRelease).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-shared-viewers')).toBe(0);
  });

  it('releases follow leases automatically when the viewer lease expires', async () => {
    let nowMs = 5_000;
    const release = vi.fn(async () => {});
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-expiring',
    });

    await manager.attach({
      sessionId: 'session-expiring',
      ttlMs: 2_000,
      acquireFollowLease: async () => ({ release }),
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(release).not.toHaveBeenCalled();

    nowMs = 7_100;
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-expiring')).toBe(0);
  });

  it('releases the attached follow lease on detach and acquires a detached background lease until disabled', async () => {
    let nowMs = 1_000;
    const attachedRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-background',
    });

    await manager.attach({
      sessionId: 'session-background',
      ttlMs: 30_000,
      acquireFollowLease: acquireAttachedFollowLease,
    });
    expect(acquireAttachedFollowLease).toHaveBeenCalledTimes(1);

    const backgroundFollow = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });

    expect(backgroundFollow).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: false }));
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

    const detached = await manager.detach({
      sessionId: 'session-background',
      leaseId: 'lease-background',
    });

    expect(detached).toEqual({ detached: true });
    expect(attachedRelease).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(1);
    expect(backgroundRelease).toHaveBeenCalledTimes(0);
    expect(manager.countActiveLeases('session-background')).toBe(0);
    expect(manager.hasBackgroundFollowLease('session-background')).toBe(true);

    const disabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background',
      enabled: false,
    });

    expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
    expect(backgroundRelease).toHaveBeenCalledTimes(1);
  });

  it('transitions from attached follow to detached background follow when the viewer lease expires', async () => {
    let nowMs = 1_000;
    const attachedRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      now: () => nowMs,
      randomId: () => 'lease-expiry-background',
    });

    await manager.attach({
      sessionId: 'session-expiry-background',
      ttlMs: 2_000,
      acquireFollowLease: acquireAttachedFollowLease,
    });
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-expiry-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(attachedRelease).not.toHaveBeenCalled();
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

    nowMs = 3_100;
    await vi.advanceTimersByTimeAsync(1);

    expect(attachedRelease).toHaveBeenCalledTimes(1);
    expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-expiry-background')).toBe(0);
    expect(manager.hasBackgroundFollowLease('session-expiry-background')).toBe(true);

    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-expiry-background',
      enabled: false,
    });
    expect(backgroundRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared background follow lease alive until the last attached viewer detaches', async () => {
    const viewerRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    const acquireViewerFollowLease = vi.fn(async () => ({ release: viewerRelease }));
    const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
    const manager = createDirectSessionFollowLeaseManager({
      randomId: () => 'lease-shared-background',
    });

    const enabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-shared-background',
      enabled: true,
      acquireFollowLease: acquireBackgroundFollowLease,
    });
    expect(enabled).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: true }));
    expect(manager.hasBackgroundFollowLease('session-shared-background')).toBe(true);

    await manager.attach({
      sessionId: 'session-shared-background',
      ttlMs: 30_000,
      acquireFollowLease: acquireViewerFollowLease,
    });

    expect(acquireViewerFollowLease).not.toHaveBeenCalled();
    expect(manager.countActiveLeases('session-shared-background')).toBe(1);

    const disabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-shared-background',
      enabled: false,
    });
    expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
    expect(backgroundRelease).not.toHaveBeenCalled();

    await manager.detach({
      sessionId: 'session-shared-background',
      leaseId: 'lease-shared-background',
    });

    expect(backgroundRelease).toHaveBeenCalledTimes(1);
    expect(viewerRelease).not.toHaveBeenCalled();
  });

  it('releases the shared viewer follow stream and disables background reacquisition when takeover succeeds', async () => {
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    const backgroundAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    let leaseIndex = 0;
    const manager = createDirectSessionFollowLeaseManager({
      randomId: () => `lease-${++leaseIndex}`,
    });

    await manager.attach({
      sessionId: 'session-takeover',
      ttlMs: 30_000,
      acquireFollowLease: async () => ({ release: firstRelease }),
    });
    await manager.attach({
      sessionId: 'session-takeover',
      ttlMs: 30_000,
      acquireFollowLease: async () => ({ release: secondRelease }),
    });
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-takeover',
      enabled: true,
      acquireFollowLease: backgroundAcquire,
    });

    const released = await manager.releaseForTakeover('session-takeover');

    expect(released).toEqual({ releasedViewerFollowLeases: 2, releasedBackgroundFollowLease: false });
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).not.toHaveBeenCalled();

    await manager.detach({ sessionId: 'session-takeover', leaseId: 'lease-1' });
    await manager.detach({ sessionId: 'session-takeover', leaseId: 'lease-2' });
    expect(backgroundAcquire).not.toHaveBeenCalled();
  });

  it('fences new viewer and background follow acquisition while the runtime owns the session', async () => {
    const viewerAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    const backgroundAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    const manager = createDirectSessionFollowLeaseManager({ randomId: () => 'lease-fenced' });

    await manager.releaseForTakeover('session-fenced');
    await manager.attach({
      sessionId: 'session-fenced',
      ttlMs: 30_000,
      acquireFollowLease: viewerAcquire,
    });
    const background = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-fenced',
      enabled: true,
      acquireFollowLease: backgroundAcquire,
    });

    expect(viewerAcquire).not.toHaveBeenCalled();
    expect(backgroundAcquire).not.toHaveBeenCalled();
    expect(background.leaseAcquired).toBe(false);
  });

  it('only lets the current takeover token commit or roll back its fence', async () => {
    const release = vi.fn(async () => {});
    const initialAcquire = vi
      .fn<() => Promise<DirectSessionFollowLease | null>>()
      .mockResolvedValueOnce({ release })
      .mockResolvedValueOnce({ release: vi.fn(async () => {}) });
    const blockedAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    const manager = createDirectSessionFollowLeaseManager({ randomId: () => 'takeover-token' });

    await manager.attach({
      sessionId: 'session-takeover-token',
      ttlMs: 30_000,
      acquireFollowLease: initialAcquire,
    });
    const first = await manager.beginTakeoverFence('session-takeover-token');
    expect(first).toMatchObject({ token: 'direct-takeover-takeover-token-1' });
    expect(release).toHaveBeenCalledTimes(1);

    expect(await manager.rollbackTakeoverFence('session-takeover-token', first!.token)).toBe(true);
    expect(initialAcquire).toHaveBeenCalledTimes(2);
    const second = await manager.beginTakeoverFence('session-takeover-token');
    expect(second).toMatchObject({ token: 'direct-takeover-takeover-token-2' });
    expect(await manager.rollbackTakeoverFence('session-takeover-token', first!.token)).toBe(false);

    await manager.attach({
      sessionId: 'session-takeover-token',
      leaseId: 'viewer-during-fence',
      ttlMs: 30_000,
      acquireFollowLease: blockedAcquire,
    });
    expect(blockedAcquire).not.toHaveBeenCalled();
    expect(await manager.commitTakeoverFence('session-takeover-token', second!.token)).toBe(true);
    expect(await manager.commitTakeoverFence('session-takeover-token', second!.token)).toBe(false);
  });

  it('releases a viewer follow lease that finishes acquiring after takeover wins the race', async () => {
    let resolveAcquire!: (lease: DirectSessionFollowLease) => void;
    const acquiredRelease = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(() => new Promise<DirectSessionFollowLease>((resolve) => {
      resolveAcquire = resolve;
    }));
    const manager = createDirectSessionFollowLeaseManager({ randomId: () => 'lease-racing' });

    const attaching = manager.attach({
      sessionId: 'session-racing',
      ttlMs: 30_000,
      acquireFollowLease,
    });
    await vi.waitFor(() => expect(acquireFollowLease).toHaveBeenCalledTimes(1));
    await manager.releaseForTakeover('session-racing');
    resolveAcquire({ release: acquiredRelease });
    await attaching;

    expect(acquiredRelease).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent detached background acquisition and releases a late result after takeover', async () => {
    let resolveAcquire!: (lease: DirectSessionFollowLease) => void;
    const lateRelease = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(() => new Promise<DirectSessionFollowLease>((resolve) => {
      resolveAcquire = resolve;
    }));
    const manager = createDirectSessionFollowLeaseManager();

    const first = manager.setBackgroundFollowEnabled({
      sessionId: 'session-background-racing',
      enabled: true,
      acquireFollowLease,
    });
    const second = manager.setBackgroundFollowEnabled({
      sessionId: 'session-background-racing',
      enabled: true,
      acquireFollowLease,
    });
    await vi.waitFor(() => expect(acquireFollowLease).toHaveBeenCalledTimes(1));

    await manager.releaseForTakeover('session-background-racing');
    resolveAcquire({ release: lateRelease });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { enabled: true, leaseAcquired: false },
      { enabled: true, leaseAcquired: false },
    ]);
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(manager.hasBackgroundFollowLease('session-background-racing')).toBe(false);
  });

  it('releases a detached background lease that finishes after its policy was disabled', async () => {
    let resolveAcquire!: (lease: DirectSessionFollowLease) => void;
    const lateRelease = vi.fn(async () => {});
    const manager = createDirectSessionFollowLeaseManager();
    const pending = manager.setBackgroundFollowEnabled({
      sessionId: 'session-background-disabled',
      enabled: true,
      acquireFollowLease: () => new Promise<DirectSessionFollowLease>((resolve) => {
        resolveAcquire = resolve;
      }),
    });
    await vi.waitFor(() => expect(resolveAcquire).toBeTypeOf('function'));

    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background-disabled',
      enabled: false,
    });
    resolveAcquire({ release: lateRelease });
    await expect(pending).resolves.toEqual({ enabled: true, leaseAcquired: false });

    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(manager.hasBackgroundFollowLease('session-background-disabled')).toBe(false);
  });

  it('disposes shared viewer and background follow leases exactly once without waiting for a pending provider acquisition', async () => {
    const viewerRelease = vi.fn(async () => {});
    const backgroundRelease = vi.fn(async () => {});
    let resolveLateAcquire!: (lease: DirectSessionFollowLease) => void;
    const lateRelease = vi.fn(async () => {});
    const manager = createDirectSessionFollowLeaseManager({ randomId: () => 'lease-dispose' });

    await manager.attach({
      sessionId: 'session-dispose-viewer',
      ttlMs: 30_000,
      acquireFollowLease: async () => ({ release: viewerRelease }),
    });
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-dispose-background',
      enabled: true,
      acquireFollowLease: async () => ({ release: backgroundRelease }),
    });
    const pendingBackground = manager.setBackgroundFollowEnabled({
      sessionId: 'session-dispose-late',
      enabled: true,
      acquireFollowLease: () => new Promise<DirectSessionFollowLease>((resolve) => {
        resolveLateAcquire = resolve;
      }),
    });
    await vi.waitFor(() => expect(resolveLateAcquire).toBeTypeOf('function'));

    await manager.dispose();
    await manager.dispose();

    expect(viewerRelease).toHaveBeenCalledTimes(1);
    expect(backgroundRelease).toHaveBeenCalledTimes(1);
    expect(manager.countActiveLeases('session-dispose-viewer')).toBe(0);
    expect(manager.hasBackgroundFollowLease('session-dispose-background')).toBe(false);
    await expect(manager.attach({ sessionId: 'session-dispose-viewer', ttlMs: 1_000 })).rejects.toThrow('disposed');

    resolveLateAcquire({ release: lateRelease });
    await pendingBackground;
    expect(lateRelease).toHaveBeenCalledTimes(1);
  });

  it('releases an active background lease and can reacquire after runtime ownership ends', async () => {
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    const backgroundAcquire = vi
      .fn<() => Promise<DirectSessionFollowLease | null>>()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    const manager = createDirectSessionFollowLeaseManager();

    const enabled = await manager.setBackgroundFollowEnabled({
      sessionId: 'session-background-runtime',
      enabled: true,
      acquireFollowLease: backgroundAcquire,
    });
    expect(enabled.leaseAcquired).toBe(true);

    const released = await manager.releaseForTakeover('session-background-runtime');
    expect(released.releasedBackgroundFollowLease).toBe(true);
    expect(firstRelease).toHaveBeenCalledTimes(1);

    await manager.setRuntimeOwned('session-background-runtime', false);
    expect(backgroundAcquire).toHaveBeenCalledTimes(2);
    expect(manager.hasBackgroundFollowLease('session-background-runtime')).toBe(true);
  });

  it('keeps the takeover fence during startup grace and clears it after status confirms no runtime', async () => {
    let nowMs = 1_000;
    const backgroundAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    const manager = createDirectSessionFollowLeaseManager({ now: () => nowMs });

    await manager.releaseForTakeover('session-runtime-grace');
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-runtime-grace',
      enabled: true,
      acquireFollowLease: backgroundAcquire,
    });
    await manager.reconcileRuntimeOwnership('session-runtime-grace', false);
    expect(backgroundAcquire).not.toHaveBeenCalled();

    nowMs += 10_001;
    await manager.reconcileRuntimeOwnership('session-runtime-grace', false);
    expect(backgroundAcquire).toHaveBeenCalledTimes(1);
  });

  it('retires existing direct follow state without reacquiring it after runtime exit', async () => {
    const viewerRelease = vi.fn(async () => {});
    const viewerAcquire = vi.fn(async () => ({ release: viewerRelease }));
    const backgroundAcquire = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    let leaseIndex = 0;
    const manager = createDirectSessionFollowLeaseManager({
      randomId: () => `lease-persisted-${++leaseIndex}`,
    });

    await manager.attach({
      sessionId: 'session-persisted',
      ttlMs: 30_000,
      acquireFollowLease: viewerAcquire,
    });
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-persisted',
      enabled: true,
      acquireFollowLease: backgroundAcquire,
    });

    await manager.retireForPersistedTakeover('session-persisted');
    await manager.setRuntimeOwned('session-persisted', false);

    expect(viewerRelease).toHaveBeenCalledTimes(1);
    expect(viewerAcquire).toHaveBeenCalledTimes(1);
    expect(backgroundAcquire).not.toHaveBeenCalled();
    expect(manager.hasBackgroundFollowLease('session-persisted')).toBe(false);
  });

  it('does not resurrect a viewer follow authorized before persisted takeover after runtime ownership clears', async () => {
    let resolveAcquire!: (lease: DirectSessionFollowLease) => void;
    const acquiredRelease = vi.fn(async () => {});
    const acquireFollowLease = vi.fn(() => new Promise<DirectSessionFollowLease>((resolve) => {
      resolveAcquire = resolve;
    }));
    const manager = createDirectSessionFollowLeaseManager({ randomId: () => 'lease-persisted-racing' });

    const attaching = manager.attach({
      sessionId: 'session-persisted-racing',
      ttlMs: 30_000,
      acquireFollowLease,
    });
    await vi.waitFor(() => expect(acquireFollowLease).toHaveBeenCalledTimes(1));

    await manager.retireForPersistedTakeover('session-persisted-racing');
    await manager.setRuntimeOwned('session-persisted-racing', false);
    resolveAcquire({ release: acquiredRelease });
    await attaching;

    expect(acquiredRelease).toHaveBeenCalledTimes(1);
  });
});
