import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';

import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from './processRunState';
import {
  readSessionRunnerProcessIdentity,
  storedProcessHashMatchesCurrentIdentity,
  storedProcessHashProvesPidReuse,
  type SessionRunnerProcessCommandHashReader,
} from './sessionRunnerProcessIdentity';
import { resolveSessionRunnerBuildId } from './sessionRunnerBuildId';
import {
  isSessionRunnerLifecycleAuthoritativelyStale,
  type SessionRunnerCleanupOutcome,
  type SessionRunnerLifecycleState,
} from './sessionRunnerLifecycleState';

export {
  isSessionRunnerLifecycleAuthoritativelyStale,
  type SessionRunnerCleanupOutcome,
  type SessionRunnerLifecyclePhase,
  type SessionRunnerLifecycleState,
} from './sessionRunnerLifecycleState';

export const SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS = 30_000;
export const SESSION_RUNNER_CLEANUP_BUDGET_MS = 15_000;

export type SessionRunnerLockPayload = Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  generationId?: string;
  processCommandHash?: string;
}>;

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sessionRunnerLocksDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'tmp', 'session-runner-locks');
}

function resolveMaxLockBasenameChars(): number {
  const raw = (process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS ?? '').trim();
  if (!raw) return 120;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 120;
  return Math.min(240, Math.max(32, parsed));
}

function resolveLockFileBasename(sessionId: string): string {
  const maxChars = resolveMaxLockBasenameChars();
  // Prefer human-readable filenames when safe; otherwise fall back to a stable hash to avoid path injection.
  if (/^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId.length <= maxChars) return sessionId;
  return `sha-${sha256Hex(sessionId)}`;
}

export function sessionRunnerLockPathForSessionId(params: Readonly<{ happyHomeDir?: string; sessionId: string }>): string | null {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return null;
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  if (!happyHomeDir) return null;
  return join(sessionRunnerLocksDir(happyHomeDir), `${resolveLockFileBasename(sessionId)}.json`);
}

function killWedgedPidDefault(pid: number): void {
  // SIGKILL works on a SIGSTOPped process; this prevents a later SIGCONT from reviving a
  // wedged runner after its lock has been handed to a replacement.
  process.kill(pid, 'SIGKILL');
}

function safeParseLockPayload(raw: string): SessionRunnerLockPayload | null {
  try {
    const parsed = JSON.parse(raw);
    const sessionId = normalizeSessionId(parsed?.sessionId);
    const pid = Number(parsed?.pid);
    const acquiredAtMs = Number(parsed?.acquiredAtMs);
    const generationIdRaw = typeof parsed?.generationId === 'string' ? parsed.generationId.trim() : '';
    const generationId = /^[A-Za-z0-9._-]{8,128}$/.test(generationIdRaw) ? generationIdRaw : undefined;
    const processCommandHashRaw = typeof parsed?.processCommandHash === 'string' ? parsed.processCommandHash : '';
    const processCommandHash = /^[a-f0-9]{64}$/.test(processCommandHashRaw) ? processCommandHashRaw : undefined;
    if (!sessionId) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return {
      sessionId,
      pid: Math.floor(pid),
      acquiredAtMs: Math.floor(acquiredAtMs),
      ...(generationId ? { generationId } : {}),
      ...(processCommandHash ? { processCommandHash } : {}),
    };
  } catch {
    return null;
  }
}

function lockPayloadMatches(left: SessionRunnerLockPayload, right: SessionRunnerLockPayload): boolean {
  return left.sessionId === right.sessionId
    && left.pid === right.pid
    && left.acquiredAtMs === right.acquiredAtMs
    && left.generationId === right.generationId
    && left.processCommandHash === right.processCommandHash;
}

type ClaimedSessionRunnerLock = Readonly<{
  ownedPath: string;
  releaseClaim: () => Promise<void>;
}>;

async function claimSessionRunnerLockGeneration(params: Readonly<{
  lockPath: string;
  expected: SessionRunnerLockPayload;
}>): Promise<ClaimedSessionRunnerLock | null> {
  const generationKey = params.expected.generationId
    ?? `legacy-${params.expected.pid}-${params.expected.acquiredAtMs}`;
  const claimPath = `${params.lockPath}.${generationKey}.claim`;
  const ownedPath = `${claimPath}.${randomUUID()}.owned`;
  try {
    await writeFile(claimPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return null;
  }

  const releaseClaim = async () => {
    await unlink(claimPath).catch(() => undefined);
  };
  try {
    const current = safeParseLockPayload(await readFile(params.lockPath, 'utf8'));
    if (!current || !lockPayloadMatches(current, params.expected)) {
      await releaseClaim();
      return null;
    }
    await rename(params.lockPath, ownedPath);
    const claimed = safeParseLockPayload(await readFile(ownedPath, 'utf8'));
    if (!claimed || !lockPayloadMatches(claimed, params.expected)) {
      await rename(ownedPath, params.lockPath).catch(() => undefined);
      await releaseClaim();
      return null;
    }
    return { ownedPath, releaseClaim };
  } catch {
    await releaseClaim();
    return null;
  }
}

function safeParseLifecycleState(raw: string): SessionRunnerLifecycleState | null {
  try {
    const parsed = JSON.parse(raw);
    const sessionId = normalizeSessionId(parsed?.sessionId);
    const pid = Number(parsed?.pid);
    const generationId = typeof parsed?.generationId === 'string' ? parsed.generationId.trim() : '';
    const phase = parsed?.phase;
    const phaseStartedAtMs = Number(parsed?.phaseStartedAtMs);
    const heartbeatAtMs = Number(parsed?.heartbeatAtMs);
    const cleanupDeadlineAtMs = Number(parsed?.cleanupDeadlineAtMs);
    const cleanupOutcome = parsed?.cleanupOutcome;
    const cliVersion = typeof parsed?.cliVersion === 'string' ? parsed.cliVersion.trim() : '';
    const runnerBuildId = typeof parsed?.runnerBuildId === 'string' ? parsed.runnerBuildId.trim() : '';

    if (!sessionId || !Number.isFinite(pid) || pid <= 0) return null;
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(generationId)) return null;
    if (phase !== 'running' && phase !== 'cleanup' && phase !== 'finished') return null;
    if (!Number.isFinite(phaseStartedAtMs) || phaseStartedAtMs <= 0) return null;
    if (!Number.isFinite(heartbeatAtMs) || heartbeatAtMs <= 0) return null;
    if (!cliVersion) return null;
    if (
      cleanupOutcome !== undefined
      && cleanupOutcome !== 'completed'
      && cleanupOutcome !== 'failed'
      && cleanupOutcome !== 'timed_out'
      && cleanupOutcome !== 'superseded'
    ) {
      return null;
    }

    return {
      sessionId,
      pid: Math.floor(pid),
      generationId,
      phase,
      phaseStartedAtMs: Math.floor(phaseStartedAtMs),
      heartbeatAtMs: Math.floor(heartbeatAtMs),
      ...(Number.isFinite(cleanupDeadlineAtMs) && cleanupDeadlineAtMs > 0
        ? { cleanupDeadlineAtMs: Math.floor(cleanupDeadlineAtMs) }
        : {}),
      ...(cleanupOutcome ? { cleanupOutcome } : {}),
      cliVersion,
      ...(runnerBuildId ? { runnerBuildId } : {}),
    };
  } catch {
    return null;
  }
}

export function sessionRunnerLifecyclePathForGeneration(params: Readonly<{
  happyHomeDir?: string;
  sessionId: string;
  generationId: string;
}>): string | null {
  const lockPath = sessionRunnerLockPathForSessionId(params);
  const generationId = String(params.generationId ?? '').trim();
  if (!lockPath || !/^[A-Za-z0-9._-]{8,128}$/.test(generationId)) return null;
  return `${lockPath.slice(0, -'.json'.length)}.${generationId}.lifecycle.json`;
}

export type AcquireSessionRunnerLockResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      pid: number;
      acquiredAtMs: number;
      generationId: string;
      lockPath: string;
      heartbeat: (nowMs?: number) => Promise<boolean>;
      markCleanup: (params?: Readonly<{ nowMs?: number; deadlineAtMs?: number }>) => Promise<boolean>;
      readLifecycle: () => Promise<SessionRunnerLifecycleState | null>;
      release: (outcome?: SessionRunnerCleanupOutcome) => Promise<void>;
    }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' }>
  | Readonly<{ ok: false; reason: 'already_running'; heldByPid: number }>
  | Readonly<{ ok: false; reason: 'io_error'; errorMessage: string }>;

export async function acquireSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid?: number;
  nowMs?: number;
  cliVersion?: string;
  runnerBuildId?: string;
  heartbeatTimeoutMs?: number;
  happyHomeDir?: string;
  readProcessRunState?: (pid: number) => Promise<ProcessRunState>;
  getCurrentProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  killWedgedPid?: (pid: number) => void | Promise<void>;
  terminationConfirmTimeoutMs?: number;
  terminationConfirmPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<AcquireSessionRunnerLockResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };

  const pid = typeof params.pid === 'number' && Number.isFinite(params.pid) && params.pid > 0 ? Math.floor(params.pid) : process.pid;
  const nowMsRaw = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const nowMs = Math.max(1, Math.floor(nowMsRaw));
  const generationId = randomUUID();
  const heartbeatTimeoutMs = Math.max(1, Math.floor(params.heartbeatTimeoutMs ?? SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS));

  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  try {
    await mkdir(sessionRunnerLocksDir(happyHomeDir), { recursive: true });
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  const readProcessIdentity = async (pidToRead: number) =>
    await readSessionRunnerProcessIdentity({
      pid: pidToRead,
      getProcessCommandHash: params.getCurrentProcessCommandHash,
    });
  const processIdentity = await readProcessIdentity(pid);
  const processCommandHash = processIdentity.kind === 'happy' ? processIdentity.processCommandHash : null;
  const runnerBuildId = String(params.runnerBuildId ?? await resolveSessionRunnerBuildId() ?? '').trim();

  const payload: SessionRunnerLockPayload = {
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    generationId,
    ...(processCommandHash ? { processCommandHash } : {}),
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const lifecyclePath = sessionRunnerLifecyclePathForGeneration({ happyHomeDir, sessionId, generationId });
  if (!lifecyclePath) return { ok: false, reason: 'invalid_session_id' };
  const initialLifecycle: SessionRunnerLifecycleState = {
    sessionId,
    pid,
    generationId,
    phase: 'running',
    phaseStartedAtMs: nowMs,
    heartbeatAtMs: nowMs,
    cliVersion: String(params.cliVersion ?? configuration.currentCliVersion ?? 'unknown').trim() || 'unknown',
    ...(runnerBuildId ? { runnerBuildId } : {}),
  };

  const tryCreate = async (): Promise<boolean> => {
    try {
      await writeFile(lockPath, serialized, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  };

  let lifecycleWriteChain = Promise.resolve();
  const readLifecycle = async (): Promise<SessionRunnerLifecycleState | null> => {
    try {
      const parsed = safeParseLifecycleState(await readFile(lifecyclePath, 'utf8'));
      return parsed?.generationId === generationId ? parsed : null;
    } catch {
      return null;
    }
  };
  const lockStillOwned = async (): Promise<boolean> => {
    try {
      const current = safeParseLockPayload(await readFile(lockPath, 'utf8'));
      return current?.sessionId === sessionId
        && current.pid === pid
        && current.acquiredAtMs === nowMs
        && current.generationId === generationId;
    } catch {
      return false;
    }
  };
  const updateLifecycle = async (
    update: (current: SessionRunnerLifecycleState) => SessionRunnerLifecycleState,
  ): Promise<boolean> => {
    let updated = false;
    const nextWrite = lifecycleWriteChain.then(async () => {
      if (!(await lockStillOwned())) return;
      const current = await readLifecycle();
      if (!current) return;
      await writeFile(lifecyclePath, JSON.stringify(update(current), null, 2) + '\n', 'utf8');
      updated = true;
    });
    lifecycleWriteChain = nextWrite.catch(() => undefined);
    await nextWrite;
    return updated;
  };
  const heartbeat = async (heartbeatNowMs: number = Date.now()): Promise<boolean> => {
    const normalizedNowMs = Math.max(1, Math.floor(heartbeatNowMs));
    return await updateLifecycle((current) => ({
      ...current,
      heartbeatAtMs: normalizedNowMs,
    }));
  };
  const markCleanup = async (
    cleanupParams: Readonly<{ nowMs?: number; deadlineAtMs?: number }> = {},
  ): Promise<boolean> => {
    const cleanupNowMs = Math.max(1, Math.floor(cleanupParams.nowMs ?? Date.now()));
    const deadlineAtMs = Math.max(
      cleanupNowMs + 1,
      Math.floor(cleanupParams.deadlineAtMs ?? cleanupNowMs + SESSION_RUNNER_CLEANUP_BUDGET_MS),
    );
    return await updateLifecycle((current) => ({
      ...current,
      phase: 'cleanup',
      phaseStartedAtMs: cleanupNowMs,
      heartbeatAtMs: cleanupNowMs,
      cleanupDeadlineAtMs: deadlineAtMs,
    }));
  };
  const buildAcquiredResult = (): Extract<AcquireSessionRunnerLockResult, { ok: true }> => ({
    ok: true,
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    generationId,
    lockPath,
    heartbeat,
    markCleanup,
    readLifecycle,
    release: async (outcome: SessionRunnerCleanupOutcome = 'completed') => {
      await lifecycleWriteChain;
      await releaseSessionRunnerLock({
        happyHomeDir,
        sessionId,
        pid,
        acquiredAtMs: nowMs,
        generationId,
        cleanupOutcome: outcome,
      }).catch(() => {});
    },
  });
  const initializeAcquiredLifecycle = async (): Promise<AcquireSessionRunnerLockResult | null> => {
    try {
      await writeFile(lifecyclePath, JSON.stringify(initialLifecycle, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      return null;
    } catch (e) {
      const failedClaim = await claimSessionRunnerLockGeneration({ lockPath, expected: payload });
      if (failedClaim) {
        await unlink(failedClaim.ownedPath).catch(() => undefined);
        await failedClaim.releaseClaim();
      }
      return {
        ok: false,
        reason: 'io_error',
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  };

  try {
    const created = await tryCreate();
    if (created) {
      const lifecycleError = await initializeAcquiredLifecycle();
      if (lifecycleError) return lifecycleError;
      return buildAcquiredResult();
    }
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  // Existing lock. If it's held by a live servable Happy session process, deny; otherwise break stale and retry once.
  let existing: SessionRunnerLockPayload | null = null;
  try {
    existing = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch {
    existing = null;
  }

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const killWedgedPid = params.killWedgedPid ?? killWedgedPidDefault;
  const sleep = params.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  const terminationConfirmTimeoutMs = Math.max(1, Math.floor(params.terminationConfirmTimeoutMs ?? 5_000));
  const terminationConfirmPollMs = Math.max(1, Math.floor(params.terminationConfirmPollMs ?? 25));
  const readHolderRunState = async (pid: number): Promise<ProcessRunState> =>
    await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  const terminateAndConfirmOriginalHolder = async (
    holder: SessionRunnerLockPayload,
  ): Promise<boolean> => {
    try {
      await killWedgedPid(holder.pid);
    } catch {
      return false;
    }
    const deadlineAtMs = Date.now() + terminationConfirmTimeoutMs;
    while (true) {
      const state = await readHolderRunState(holder.pid);
      if (state === 'dead' || state === 'zombie') return true;
      const identity = await readProcessIdentity(holder.pid);
      if (!storedProcessHashMatchesCurrentIdentity({
        storedProcessCommandHash: holder.processCommandHash,
        currentIdentity: identity,
      })) {
        return false;
      }
      if (Date.now() >= deadlineAtMs) return false;
      await sleep(Math.min(terminationConfirmPollMs, Math.max(1, deadlineAtMs - Date.now())));
    }
  };

  if (existing && existing.sessionId !== sessionId) {
    if (existing.pid && (await readHolderRunState(existing.pid)) !== 'dead') {
      return { ok: false, reason: 'already_running', heldByPid: existing.pid };
    }
    // Do not reclaim an ownership record for a different session without a
    // generation-matched claim. A malformed/mismatched record stays fail-closed.
    return { ok: false, reason: 'already_running', heldByPid: existing.pid };
  }

  if (existing?.pid) {
    const holderState = await readHolderRunState(existing.pid);
    if (holderState === 'dead' || holderState === 'zombie') {
      // Dead or defunct: cannot serve, safe to break below (a zombie needs no kill).
    } else if (existing.processCommandHash) {
      const currentIdentity = await readProcessIdentity(existing.pid);
      const existingLifecycle = existing.generationId
        ? await readSessionRunnerLifecycleState({
          happyHomeDir,
          sessionId,
          generationId: existing.generationId,
        })
        : null;
      const authoritativeStale = isSessionRunnerLifecycleAuthoritativelyStale({
        lifecycle: existingLifecycle,
        nowMs,
        heartbeatTimeoutMs,
      });
      if (storedProcessHashProvesPidReuse({
        storedProcessCommandHash: existing.processCommandHash,
        currentIdentity,
      })) {
        // Provably a different process (PID reuse) or not a Happy process: treat the lock as stale and break it.
      } else if (
        authoritativeStale
        && storedProcessHashMatchesCurrentIdentity({
          storedProcessCommandHash: existing.processCommandHash,
          currentIdentity,
        })
      ) {
        if (
          existingLifecycle?.phase !== 'finished'
          && !(await terminateAndConfirmOriginalHolder(existing))
        ) {
          return { ok: false, reason: 'already_running', heldByPid: existing.pid };
        }
      } else if (holderState === 'stopped' && storedProcessHashMatchesCurrentIdentity({
        storedProcessCommandHash: existing.processCommandHash,
        currentIdentity,
      })) {
        // Proven same runner image but SIGSTOPped: it holds the lock and serves nothing
        // (incident 2026-06-12 "already running" refusal while wedged). Kill it so a
        // later SIGCONT cannot revive a duplicate, then break the lock.
        if (!(await terminateAndConfirmOriginalHolder(existing))) {
          return { ok: false, reason: 'already_running', heldByPid: existing.pid };
        }
      } else {
        // Fail-closed: if the lock PID is alive and we cannot prove it's stale, deny.
        return { ok: false, reason: 'already_running', heldByPid: existing.pid };
      }
    } else {
      // Fail-closed: without a command hash, we can't safely distinguish PID reuse.
      return { ok: false, reason: 'already_running', heldByPid: existing.pid };
    }
  }

  if (!existing) {
    return { ok: false, reason: 'io_error', errorMessage: 'Existing lock payload is invalid and cannot be claimed safely' };
  }
  const claimed = await claimSessionRunnerLockGeneration({ lockPath, expected: existing });
  if (!claimed) {
    const current = await readSessionRunnerLockStatus({ happyHomeDir, sessionId }).catch(() => null);
    if (current?.ok) {
      return { ok: false, reason: 'already_running', heldByPid: current.lock.pid };
    }
    return { ok: false, reason: 'io_error', errorMessage: 'Existing lock generation changed before recovery claim' };
  }

  try {
    const createdAfterBreak = await tryCreate();
    if (!createdAfterBreak) {
      // Someone else raced us; best-effort read to report a PID.
      const raced = await readSessionRunnerLockStatus({ happyHomeDir, sessionId }).catch(() => null);
      if (raced && raced.ok) {
        return { ok: false, reason: 'already_running', heldByPid: raced.lock.pid };
      }
      return { ok: false, reason: 'io_error', errorMessage: 'Lock acquisition raced and could not read existing lock' };
    }
    const lifecycleError = await initializeAcquiredLifecycle();
    if (lifecycleError) return lifecycleError;
    await unlink(claimed.ownedPath).catch(() => undefined);
    await claimed.releaseClaim();
    return buildAcquiredResult();
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  } finally {
    await unlink(claimed.ownedPath).catch(() => undefined);
    await claimed.releaseClaim();
  }
}

export type ReleaseSessionRunnerLockResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' }>
  | Readonly<{ ok: false; reason: 'not_found' }>
  | Readonly<{ ok: false; reason: 'not_owner' }>
  | Readonly<{ ok: false; reason: 'io_error'; errorMessage: string }>;

export async function releaseSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  generationId?: string;
  nowMs?: number;
  cleanupOutcome?: SessionRunnerCleanupOutcome;
  happyHomeDir?: string;
}>): Promise<ReleaseSessionRunnerLockResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  let existing: SessionRunnerLockPayload | null = null;
  try {
    existing = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  if (!existing) return { ok: false, reason: 'not_owner' };
  if (existing.sessionId !== sessionId) return { ok: false, reason: 'not_owner' };
  if (existing.pid !== params.pid) return { ok: false, reason: 'not_owner' };
  if (existing.acquiredAtMs !== params.acquiredAtMs) return { ok: false, reason: 'not_owner' };
  if (existing.generationId && existing.generationId !== params.generationId) {
    return { ok: false, reason: 'not_owner' };
  }

  const claimed = await claimSessionRunnerLockGeneration({ lockPath, expected: existing });
  if (!claimed) return { ok: false, reason: 'not_owner' };

  try {
    if (existing.generationId) {
      const lifecyclePath = sessionRunnerLifecyclePathForGeneration({
        happyHomeDir,
        sessionId,
        generationId: existing.generationId,
      });
      if (lifecyclePath) {
        const nowMs = Math.max(1, Math.floor(params.nowMs ?? Date.now()));
        const current = await readSessionRunnerLifecycleState({
          happyHomeDir,
          sessionId,
          generationId: existing.generationId,
        });
        if (current) {
          const finished: SessionRunnerLifecycleState = {
            ...current,
            phase: 'finished',
            phaseStartedAtMs: nowMs,
            heartbeatAtMs: nowMs,
            cleanupOutcome: params.cleanupOutcome ?? 'completed',
          };
          await writeFile(lifecyclePath, JSON.stringify(finished, null, 2) + '\n', 'utf8').catch(() => undefined);
        }
      }
    }
    await unlink(claimed.ownedPath);
    return { ok: true };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  } finally {
    await claimed.releaseClaim();
  }
}

export type SessionRunnerLockStatus =
  | Readonly<{ ok: true; lock: SessionRunnerLockPayload; lifecycle?: SessionRunnerLifecycleState }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' | 'not_found' | 'invalid' | 'io_error'; errorMessage?: string }>;

export async function readSessionRunnerLockStatus(params: Readonly<{ sessionId: string; happyHomeDir?: string }>): Promise<SessionRunnerLockStatus> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = safeParseLockPayload(raw);
    if (!parsed) return { ok: false, reason: 'invalid' };
    if (parsed.sessionId !== sessionId) return { ok: false, reason: 'invalid' };
    const lifecycle = parsed.generationId
      ? await readSessionRunnerLifecycleState({
        happyHomeDir,
        sessionId,
        generationId: parsed.generationId,
      })
      : null;
    return {
      ok: true,
      lock: parsed,
      ...(lifecycle ? { lifecycle } : {}),
    };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

export async function readSessionRunnerLifecycleState(params: Readonly<{
  sessionId: string;
  generationId: string;
  happyHomeDir?: string;
}>): Promise<SessionRunnerLifecycleState | null> {
  const lifecyclePath = sessionRunnerLifecyclePathForGeneration(params);
  if (!lifecyclePath) return null;
  try {
    const parsed = safeParseLifecycleState(await readFile(lifecyclePath, 'utf8'));
    if (!parsed) return null;
    if (parsed.sessionId !== normalizeSessionId(params.sessionId)) return null;
    if (parsed.generationId !== params.generationId) return null;
    return parsed;
  } catch {
    return null;
  }
}
