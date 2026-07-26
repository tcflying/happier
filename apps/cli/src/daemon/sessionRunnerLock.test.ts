import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireSessionRunnerLock,
  readSessionRunnerLockStatus,
  releaseSessionRunnerLock,
  sessionRunnerLockPathForSessionId,
} from './sessionRunnerLock';

describe('sessionRunnerLock', () => {
  it('acquires and releases a new lock', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_1',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_1' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(
      expect.objectContaining({
        sessionId: 'sess_1',
        pid: 123,
        acquiredAtMs: 10_000,
        generationId: expect.any(String),
        processCommandHash: 'a'.repeat(64),
      }),
    );

    await res.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
    const lifecycle = await res.readLifecycle();
    expect(lifecycle).toEqual(expect.objectContaining({
      generationId: res.generationId,
      phase: 'finished',
      cleanupOutcome: 'completed',
    }));
  });

  it('records heartbeat and cleanup lifecycle state under the acquired generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_lifecycle',
      pid: 123,
      nowMs: 10_000,
      cliVersion: '1.2.3',
      runnerBuildId: 'build-a',
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await expect(res.heartbeat(11_000)).resolves.toBe(true);
    await expect(res.markCleanup({ nowMs: 12_000, deadlineAtMs: 13_000 })).resolves.toBe(true);

    const status = await readSessionRunnerLockStatus({ happyHomeDir, sessionId: 'sess_lifecycle' });
    expect(status).toEqual({
      ok: true,
      lock: expect.objectContaining({ generationId: res.generationId }),
      lifecycle: expect.objectContaining({
        generationId: res.generationId,
        heartbeatAtMs: 12_000,
        phase: 'cleanup',
        phaseStartedAtMs: 12_000,
        cleanupDeadlineAtMs: 13_000,
        cliVersion: '1.2.3',
        runnerBuildId: 'build-a',
      }),
    });
  });

  it('recovers a live matching runner after its authoritative cleanup deadline', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const killedPids: number[] = [];
    const first = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_stale_cleanup',
      pid: 999,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async (pid) => (pid === 999 && killedPids.includes(pid) ? 'dead' : 'servable'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.markCleanup({ nowMs: 11_000, deadlineAtMs: 12_000 });

    const recovered = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_stale_cleanup',
      pid: 123,
      nowMs: 12_001,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async (pid) => (pid === 999 && killedPids.includes(pid) ? 'dead' : 'servable'),
      killWedgedPid: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(recovered.ok).toBe(true);
    expect(killedPids).toEqual([999]);
    if (!recovered.ok) return;
    expect(recovered.generationId).not.toBe(first.generationId);
    await expect(first.heartbeat(12_002)).resolves.toBe(false);
  });

  it('waits for stale-holder termination and confirms the original identity is no longer servable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const first = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_confirm_termination',
      pid: 999,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.markCleanup({ nowMs: 11_000, deadlineAtMs: 12_000 });

    let terminateResolved = false;
    let resolveTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      resolveTermination = () => {
        terminateResolved = true;
        resolve();
      };
    });
    let acquisitionSettled = false;
    const pending = acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_confirm_termination',
      pid: 123,
      nowMs: 12_001,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async (pid) => (pid === 999 && !terminateResolved ? 'servable' : 'dead'),
      killWedgedPid: async () => await terminationGate,
    }).finally(() => {
      acquisitionSettled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(acquisitionSettled).toBe(false);
    resolveTermination();
    await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('fails closed when termination returns but the same stale holder remains live', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const first = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_termination_unconfirmed',
      pid: 999,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.markCleanup({ nowMs: 11_000, deadlineAtMs: 12_000 });

    const recovered = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_termination_unconfirmed',
      pid: 123,
      nowMs: 12_001,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async () => 'servable',
      killWedgedPid: async () => undefined,
      terminationConfirmTimeoutMs: 2,
      terminationConfirmPollMs: 1,
    });

    expect(recovered).toEqual({ ok: false, reason: 'already_running', heldByPid: 999 });
    const status = await readSessionRunnerLockStatus({
      happyHomeDir,
      sessionId: 'sess_termination_unconfirmed',
    });
    expect(status).toEqual(expect.objectContaining({
      ok: true,
      lock: expect.objectContaining({ generationId: first.generationId, pid: 999 }),
    }));
  });

  it('does not let release delete a replacement during stale recovery', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const first = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_release_recovery_race',
      pid: 999,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.markCleanup({ nowMs: 11_000, deadlineAtMs: 12_000 });

    let terminated = false;
    let resolveTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      resolveTermination = () => {
        terminated = true;
        resolve();
      };
    });
    const recovery = acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_release_recovery_race',
      pid: 123,
      nowMs: 12_001,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async (pid) => (pid === 999 && terminated ? 'dead' : 'servable'),
      killWedgedPid: async () => await terminationGate,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await first.release('completed');
    resolveTermination();
    const recoveryResult = await recovery;
    expect(recoveryResult.ok).toBe(false);
    const status = await readSessionRunnerLockStatus({
      happyHomeDir,
      sessionId: 'sess_release_recovery_race',
    });
    expect(status).toEqual({ ok: false, reason: 'not_found' });
  });

  it('allows only one stale acquirer to claim an original generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const first = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_double_recovery',
      pid: 999,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'a'.repeat(64),
      readProcessRunState: async () => 'servable',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.markCleanup({ nowMs: 11_000, deadlineAtMs: 12_000 });

    let terminated = false;
    let waiting = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = () => {
        terminated = true;
        resolve();
      };
    });
    const acquireReplacement = (pid: number) => acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_double_recovery',
      pid,
      nowMs: 12_001 + pid,
      getCurrentProcessCommandHash: async (candidatePid) => (
        candidatePid === 999 ? 'a'.repeat(64) : String(candidatePid).padStart(64, 'b').slice(-64)
      ),
      readProcessRunState: async (candidatePid) => (
        candidatePid === 999 && terminated ? 'dead' : 'servable'
      ),
      killWedgedPid: async () => {
        waiting += 1;
        if (waiting === 2) releaseBarrier();
        await barrier;
      },
    });

    const results = await Promise.all([acquireReplacement(123), acquireReplacement(124)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const status = await readSessionRunnerLockStatus({ happyHomeDir, sessionId: 'sess_double_recovery' });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect([123, 124]).toContain(status.lock.pid);
    expect(status.lock.generationId).not.toBe(first.generationId);
  });

  it('keeps unknown live process identity fail-closed without authoritative stale lifecycle evidence', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_unknown_identity' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        sessionId: 'sess_unknown_identity',
        pid: 999,
        acquiredAtMs: 1,
        processCommandHash: 'a'.repeat(64),
      }, null, 2),
      'utf8',
    );

    const recovered = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_unknown_identity',
      pid: 123,
      nowMs: 100_000,
      getCurrentProcessCommandHash: async (pid) => {
        if (pid === 999) throw new Error('optional identity probe unavailable');
        return 'b'.repeat(64);
      },
      readProcessRunState: async () => 'servable',
    });

    expect(recovered).toEqual({ ok: false, reason: 'already_running', heldByPid: 999 });
  });

  it('uses a hashed lock filename when sessionId is too long', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));

    const old = process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS;
    process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS = '10';
    try {
      const sessionId = 'sess_' + 'a'.repeat(100);
      const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
      expect(lockPath).not.toBeNull();
      if (!lockPath) return;
      expect(basename(lockPath)).toMatch(/^sha-[a-f0-9]{64}\.json$/);
    } finally {
      if (old === undefined) {
        delete process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS;
      } else {
        process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS = old;
      }
    }
  });

  it('denies acquisition when a live safe pid holds the lock', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_2' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_2', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_2',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');
    if (res.reason !== 'already_running') {
      throw new Error(`Expected already_running, got ${res.reason}`);
    }
    expect(res.heldByPid).toBe(999);

    // Lock file should remain.
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('breaks a stale lock when pid is not alive', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_3' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_3', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_3',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'b'.repeat(64),
      readProcessRunState: async () => 'dead',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('breaks a lock held by a live pid when command hash mismatch can be confirmed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_5' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_5', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_5',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'c'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('breaks a lock held by a live pid when its stored hash belongs to a non-Happier process', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_5_non_happy' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_5_non_happy', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_5_non_happy',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? null : 'b'.repeat(64)),
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('does not break a lock held by a live pid when command hash cannot be inspected', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_6' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_6', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_6',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => {
        if (pid === 999) throw new Error('process inspection failed');
        return 'b'.repeat(64);
      },
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('denies acquisition when a live pid holds a lock file with a mismatched sessionId payload', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_7' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ sessionId: 'other', pid: 999, acquiredAtMs: 1 }, null, 2), 'utf8');

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_7',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'b'.repeat(64),
      readProcessRunState: async () => 'servable',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');
    if (res.reason !== 'already_running') {
      throw new Error(`Expected already_running, got ${res.reason}`);
    }
    expect(res.heldByPid).toBe(999);

    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('does not delete a lock on release if another pid owns it', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_4' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ sessionId: 'sess_4', pid: 999, acquiredAtMs: 1 }, null, 2), 'utf8');

    const released = await releaseSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_4',
      pid: 123,
      acquiredAtMs: 10_000,
    });
    expect(released.ok).toBe(false);
    if (released.ok) return;
    expect(released.reason).toBe('not_owner');
  });

  it('breaks a lock held by a STOPPED pid with a proven-matching command hash, killing the wedged holder', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_8' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_8', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const killedPids: number[] = [];
    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_8',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? 'a'.repeat(64) : 'b'.repeat(64)),
      readProcessRunState: async (pid) => (
        pid === 999 ? (killedPids.includes(pid) ? 'dead' : 'stopped') : 'servable'
      ),
      killWedgedPid: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(killedPids).toEqual([999]);
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('breaks a lock held by a STOPPED non-Happier pid without killing the unrelated process', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_8_non_happy' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_8_non_happy', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const killedPids: number[] = [];
    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_8_non_happy',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => (pid === 999 ? null : 'b'.repeat(64)),
      readProcessRunState: async (pid) => (pid === 999 ? 'stopped' : 'servable'),
      killWedgedPid: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(killedPids).toEqual([]);
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });

  it('does NOT break a lock held by a STOPPED pid when the command hash cannot prove identity', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_9' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_9', pid: 999, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) }, null, 2),
      'utf8',
    );

    const killedPids: number[] = [];
    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_9',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async (pid) => {
        if (pid === 999) throw new Error('process inspection failed');
        return 'b'.repeat(64);
      },
      readProcessRunState: async (pid) => (pid === 999 ? 'stopped' : 'servable'),
      killWedgedPid: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('already_running');
    expect(killedPids).toEqual([]);
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(999);
  });

  it('breaks a lock held by a ZOMBIE pid without requiring a kill', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-lock-'));
    const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId: 'sess_10' });
    expect(lockPath).not.toBeNull();
    if (!lockPath) return;

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ sessionId: 'sess_10', pid: 999, acquiredAtMs: 1 }, null, 2),
      'utf8',
    );

    const res = await acquireSessionRunnerLock({
      happyHomeDir,
      sessionId: 'sess_10',
      pid: 123,
      nowMs: 10_000,
      getCurrentProcessCommandHash: async () => 'b'.repeat(64),
      readProcessRunState: async (pid) => (pid === 999 ? 'zombie' : 'servable'),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const raw = await readFile(lockPath, 'utf8');
    expect(JSON.parse(raw).pid).toBe(123);
  });
});
