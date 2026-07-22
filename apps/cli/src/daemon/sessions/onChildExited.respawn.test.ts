import { describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';

describe('createOnChildExited', () => {
  it('queues durable session-end when a tracked child exits', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };
    const onSessionRuntimeEnded = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
      onSessionRuntimeEnded,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
      exit: expect.objectContaining({
        observedBy: 'daemon',
        pid,
        reason: 'process-exited',
      }),
    }));
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
    expect(onSessionRuntimeEnded).toHaveBeenCalledWith(
      'session-1',
      tracked,
      { reason: 'process-exited', code: 0, signal: null },
      { isUnexpected: false, respawnPending: false },
    );
  });

  it('reports whether a final runner exit is unexpected so ownership can stay fenced during respawn', () => {
    const pid = 124;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-respawn-fence' };
    const onSessionRuntimeEnded = vi.fn();
    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onSessionRuntimeEnded,
    } as any);

    onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onSessionRuntimeEnded).toHaveBeenCalledWith(
      'session-respawn-fence',
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { isUnexpected: true, respawnPending: false },
    );
  });

  it('reports a pending respawn before runtime ownership cleanup runs', () => {
    const pid = 125;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-respawn-pending' };
    const onSessionRuntimeEnded = vi.fn();
    const onUnexpectedExit = vi.fn(() => true);
    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onSessionRuntimeEnded,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-error', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledBefore(onSessionRuntimeEnded);
    expect(onSessionRuntimeEnded).toHaveBeenCalledWith(
      'session-respawn-pending',
      tracked,
      { reason: 'process-error', code: 1, signal: null },
      { isUnexpected: true, respawnPending: true },
    );
  });

  it('does not queue session-end for an obsolete pid when another live pid owns the same session', () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1' };
    const replacement = { pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([
      [obsoletePid, obsolete],
      [livePid, replacement],
    ]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };
    const onUnexpectedExit = vi.fn();
    const onSessionRuntimeEnded = vi.fn();
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
      onUnexpectedExit,
      onSessionRuntimeEnded,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(onSessionRuntimeEnded).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(obsoletePid)).toBe(false);
    expect(pidToTrackedSession.get(livePid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
    }));
    killSpy.mockRestore();
  });

  // Lane N1 (incident cmq7pyqkj): a killed runner's open canonical turn must be settled
  // server-side by the daemon even when a live replacement runner exists (the case where the
  // full session-end is deliberately skipped). The daemon is the single owner of
  // "I observed this runner die ⇒ its open turn is cancelled".
  it('settles the open canonical turn even when a live replacement owns the same session', () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1' };
    const replacement = { pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([
      [obsoletePid, obsolete],
      [livePid, replacement],
    ]);
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-exited', code: 0, signal: 'SIGTERM' });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
      time: expect.any(Number),
    }));
    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('settles the open canonical turn on a normal tracked exit too', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
    }));
    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalled();
  });

  it('does not settle the canonical turn when a wrapper pid promotes to a live runner pid', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[wrapperPid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).not.toHaveBeenCalled();
    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-1', pid: 123 }),
      expect.objectContaining({ code: 1 }),
    );
  });

  it('invokes onUnexpectedExit hook for process-missing with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('invokes onUnexpectedExit hook for process-reused with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-reused', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onUnexpectedExit hook for SIGTERM', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(0);
  });

  it('invokes onUnexpectedExit hook for SIGTERM when override marks it unexpected', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('promotes tracking to the runner pid and preserves the runner marker when the wrapper exits', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async (_pid: number) => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-1',
      }),
    );
    expect(pidToTrackedSession.get(runnerPid)?.sessionRunnerPid).toBeUndefined();
    killSpy.mockRestore();
  });

  it('promotes a live runner even when a connected-service restart marked the wrapper exit as unexpected', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const onUnexpectedExit = vi.fn();
    const onPidPromoted = vi.fn();
    const removeSessionMarkerFn = vi.fn(async (_pid: number) => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
      onPidPromoted,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
      pid: runnerPid,
    }));
    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(onPidPromoted).toHaveBeenCalledWith(expect.objectContaining({
      fromPid: wrapperPid,
      toPid: runnerPid,
      trackedSession: expect.objectContaining({ happySessionId: 'session-1' }),
    }));
    killSpy.mockRestore();
  });

  it('transfers pid-owned cleanup registrations when promoting wrapper tracking to the runner', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const wrapperCleanup = vi.fn();
    const wrapperAttachCleanup = vi.fn(async () => {});
    const spawnResourceCleanupByPid = new Map<number, () => void>([[wrapperPid, wrapperCleanup]]);
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>([[wrapperPid, wrapperAttachCleanup]]);

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(wrapperCleanup).not.toHaveBeenCalled();
    expect(wrapperAttachCleanup).not.toHaveBeenCalled();
    expect(spawnResourceCleanupByPid.has(wrapperPid)).toBe(false);
    expect(sessionAttachCleanupByPid.has(wrapperPid)).toBe(false);
    expect(spawnResourceCleanupByPid.get(runnerPid)).toBe(wrapperCleanup);
    expect(sessionAttachCleanupByPid.get(runnerPid)).toBe(wrapperAttachCleanup);
    killSpy.mockRestore();
  });

  it('removes both wrapper and runner markers when the wrapper exits after the runner is already gone', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    killSpy.mockRestore();
  });

  it('preserves the durable marker when the caller keeps a connected-service restart intent pending', async () => {
    const pid = 789;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-restart-intent' };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      shouldPreserveSessionMarkerOnExit: () => true,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(pidToTrackedSession.has(pid)).toBe(false);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(pid);
  });
});
