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

  it('releases active follow streams and disables background reacquisition when takeover succeeds', async () => {
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
    expect(secondRelease).toHaveBeenCalledTimes(1);

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
