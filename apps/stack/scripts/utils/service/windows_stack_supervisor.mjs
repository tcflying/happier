import { readFile, rm, writeFile } from 'node:fs/promises';

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 1) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLeaseRecord(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    const pid = Number(parsed?.pid);
    const generationId = String(parsed?.generationId ?? '').trim();
    const acquiredAt = String(parsed?.acquiredAt ?? '').trim();
    if (!Number.isFinite(pid) || pid <= 1 || !generationId || !acquiredAt) return null;
    return { pid, generationId, acquiredAt };
  } catch {
    return null;
  }
}

export async function acquireWindowsStackSupervisorLease({
  lockPath,
  pid = process.pid,
  generationId,
  now = Date.now,
  isPidAliveImpl = isPidAlive,
} = {}) {
  const ownerPid = Number(pid);
  const ownerGenerationId = String(generationId ?? '').trim();
  if (!String(lockPath ?? '').trim()) throw new Error('[service supervisor] missing lock path');
  if (!Number.isFinite(ownerPid) || ownerPid <= 1) throw new Error('[service supervisor] invalid owner pid');
  if (!ownerGenerationId) throw new Error('[service supervisor] missing generation id');

  const owner = {
    pid: ownerPid,
    generationId: ownerGenerationId,
    acquiredAt: new Date(now()).toISOString(),
  };

  const tryAcquire = async () => {
    try {
      await writeFile(lockPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };

  if (!(await tryAcquire())) {
    const existing = await readLeaseRecord(lockPath);
    if (existing && isPidAliveImpl(existing.pid)) {
      return { ok: false, reason: 'already_running', owner: existing };
    }
    await rm(lockPath, { force: true });
    if (!(await tryAcquire())) {
      const racedOwner = await readLeaseRecord(lockPath);
      return { ok: false, reason: 'already_running', owner: racedOwner };
    }
  }

  let released = false;
  return {
    ok: true,
    owner,
    async release() {
      if (released) return;
      released = true;
      const current = await readLeaseRecord(lockPath);
      if (current?.generationId !== ownerGenerationId || current?.pid !== ownerPid) return;
      await rm(lockPath, { force: true });
    },
  };
}

function resolveStartupPhase(report) {
  const dimensions = report?.dimensions ?? {};
  if (dimensions.relay?.ok !== true) return 'relay';
  if (dimensions.ui?.ok !== true) return 'ui';
  if (report?.status === 'blocked' && report?.restartable !== true) return 'ready';
  if (dimensions.rpc?.ok !== true || dimensions.sessionRunner?.ok !== true) return 'daemon';
  return 'ready';
}

export async function waitForWindowsStackStartup({
  probeHealth,
  sleep,
  maxAttempts = 30,
  pollMs = 1_000,
  onPhase = () => {},
} = {}) {
  if (typeof probeHealth !== 'function') throw new Error('[service supervisor] probeHealth is required');
  if (typeof sleep !== 'function') throw new Error('[service supervisor] sleep is required');

  const attempts = Math.max(1, Number(maxAttempts) || 1);
  let latestReport = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latestReport = await probeHealth();
    const phase = resolveStartupPhase(latestReport);
    onPhase(phase, latestReport);
    if (phase === 'ready') {
      return { ok: true, report: latestReport, attempts: attempt };
    }
    if (attempt < attempts) {
      await sleep(pollMs);
    }
  }
  return {
    ok: false,
    reason: 'startup_health_timeout',
    phase: resolveStartupPhase(latestReport),
    report: latestReport,
    attempts,
  };
}

export async function runWindowsStackSupervisor({
  lockPath,
  pid = process.pid,
  generationId,
  now = Date.now,
  isPidAliveImpl = isPidAlive,
  startStack,
  stopStack,
  probeHealth,
  waitForEvent,
  sleep,
  writeState = async () => {},
  maxRestarts = 3,
  restartWindowMs = 5 * 60_000,
  restartBackoffMs = 1_000,
  initialRestartTimestamps = [],
  startupMaxAttempts = 30,
  startupPollMs = 1_000,
} = {}) {
  for (const [name, fn] of Object.entries({ startStack, stopStack, probeHealth, waitForEvent, sleep, writeState })) {
    if (typeof fn !== 'function') throw new Error(`[service supervisor] ${name} is required`);
  }

  const lease = await acquireWindowsStackSupervisorLease({
    lockPath,
    pid,
    generationId,
    now,
    isPidAliveImpl,
  });
  if (!lease.ok) return { status: 'already_running', owner: lease.owner ?? null };

  const restartLimit = Math.max(0, Number(maxRestarts) || 0);
  const restartWindow = Math.max(1, Number(restartWindowMs) || 1);
  const restartTimestamps = Array.isArray(initialRestartTimestamps)
    ? initialRestartTimestamps
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((left, right) => left - right)
    : [];
  let child = null;

  const publish = async (phase, details = {}) => {
    const state = {
      version: 1,
      phase,
      supervisorPid: Number(pid),
      generationId: String(generationId),
      childPid: Number(child?.pid) > 1 ? Number(child.pid) : null,
      restartCount: restartTimestamps.length,
      restartTimestamps: [...restartTimestamps],
      updatedAt: new Date(now()).toISOString(),
      ...details,
    };
    await writeState(state);
    return state;
  };

  try {
    while (true) {
      child = await startStack();
      await publish('starting');
      const startup = await waitForWindowsStackStartup({
        probeHealth,
        sleep,
        maxAttempts: startupMaxAttempts,
        pollMs: startupPollMs,
        onPhase: () => {},
      });

      if (startup.ok) {
        await publish('running', { health: startup.report });
      }

      let event = startup.ok
        ? null
        : { type: 'startup_failed', reason: startup.reason, health: startup.report };
      while (startup.ok && event == null) {
        const observed = await waitForEvent({ child, health: startup.report });
        if (observed?.type === 'health_ok') {
          await publish('running', {
            health: observed.health ?? startup.report,
            lastHealthCheckAt: new Date(now()).toISOString(),
          });
          continue;
        }
        event = observed ?? { type: 'monitor_failed' };
      }

      if (event?.type === 'stop_requested') {
        await publish('stopping', { reason: 'stop_requested' });
        try {
          await stopStack(child, {
            reason: 'stop_requested',
            requestedBy: String(event.requestedBy ?? '').trim() || 'windows_service_supervisor',
            preserveDaemon: event.preserveDaemon === true,
            stopSessions: event.stopSessions !== false,
          });
        } catch {
          const state = await publish('stop_failed', {
            reason: 'safe_stop_failed',
          });
          return { status: 'stop_failed', state };
        }
        child = null;
        const state = await publish('stopped', { reason: 'stop_requested' });
        return { status: 'stopped', state };
      }

      await stopStack(child, {
        reason: event?.type ?? 'health_failure',
        preserveDaemon: true,
        stopSessions: false,
      });
      child = null;

      const at = Number(now());
      while (restartTimestamps.length > 0 && at - restartTimestamps[0] > restartWindow) {
        restartTimestamps.shift();
      }
      if (restartTimestamps.length >= restartLimit) {
        const state = await publish('crash_budget_exhausted', {
          reason: event?.type ?? 'unknown_failure',
          lastEvent: event ?? null,
        });
        return { status: 'crash_budget_exhausted', state };
      }

      restartTimestamps.push(at);
      await publish('restarting', {
        reason: event?.type ?? 'unknown_failure',
        lastEvent: event ?? null,
      });
      await sleep(restartBackoffMs);
    }
  } finally {
    if (child) {
      await stopStack(child, { reason: 'supervisor_finalizer' }).catch(() => {});
    }
    await lease.release();
  }
}
