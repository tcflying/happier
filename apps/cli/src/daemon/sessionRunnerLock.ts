import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { configuration } from '@/configuration';

import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from './processRunState';
import {
  readSessionRunnerProcessIdentity,
  storedProcessHashMatchesCurrentIdentity,
  storedProcessHashProvesPidReuse,
  type SessionRunnerProcessCommandHashReader,
} from './sessionRunnerProcessIdentity';
import { resolveSessionRunnerBuildId } from './sessionRunnerBuildId';
import { readProcessStartTimeMs, type ProcessStartTimeReader } from './processStartTime';
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
  processStartTimeMs?: number;
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
    const processStartTimeMsRaw = Number(parsed?.processStartTimeMs);
    const processStartTimeMs = Number.isFinite(processStartTimeMsRaw) && processStartTimeMsRaw > 0
      ? Math.floor(processStartTimeMsRaw) : undefined;
    if (!sessionId) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return {
      sessionId,
      pid: Math.floor(pid),
      acquiredAtMs: Math.floor(acquiredAtMs),
      ...(generationId ? { generationId } : {}),
      ...(processCommandHash ? { processCommandHash } : {}),
      ...(processStartTimeMs ? { processStartTimeMs } : {}),
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
    && left.processCommandHash === right.processCommandHash
    && left.processStartTimeMs === right.processStartTimeMs;
}

type ClaimedSessionRunnerLock = Readonly<{
  ownedPath: string;
  releaseClaim: () => Promise<void>;
}>;

type SessionRunnerLockClaimMarker = Readonly<{
  v: 1;
  generationId: string;
  claimantPid: number;
  claimantProcessCommandHash?: string;
  claimantProcessStartTimeMs?: number;
  createdAtMs: number;
  nonce: string;
}>;

function safeParseClaimMarker(raw: string): SessionRunnerLockClaimMarker | null {
  try {
    const parsed = JSON.parse(raw);
    const generationId = typeof parsed?.generationId === 'string' ? parsed.generationId.trim() : '';
    const claimantPid = Number(parsed?.claimantPid);
    const claimantProcessCommandHash = typeof parsed?.claimantProcessCommandHash === 'string'
      ? parsed.claimantProcessCommandHash.trim()
      : '';
    const claimantProcessStartTimeMsRaw = Number(parsed?.claimantProcessStartTimeMs);
    const claimantProcessStartTimeMs = Number.isFinite(claimantProcessStartTimeMsRaw)
      && claimantProcessStartTimeMsRaw > 0
      ? Math.floor(claimantProcessStartTimeMsRaw)
      : undefined;
    const createdAtMs = Number(parsed?.createdAtMs);
    const nonce = typeof parsed?.nonce === 'string' ? parsed.nonce.trim() : '';
    if (parsed?.v !== 1) return null;
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(generationId)) return null;
    if (!Number.isFinite(claimantPid) || claimantPid <= 0) return null;
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(nonce)) return null;
    if (claimantProcessCommandHash && !/^[a-f0-9]{64}$/.test(claimantProcessCommandHash)) return null;
    return {
      v: 1,
      generationId,
      claimantPid: Math.floor(claimantPid),
      ...(claimantProcessCommandHash ? { claimantProcessCommandHash } : {}),
      ...(claimantProcessStartTimeMs ? { claimantProcessStartTimeMs } : {}),
      createdAtMs: Math.floor(createdAtMs),
      nonce,
    };
  } catch {
    return null;
  }
}

function claimMarkerMatches(left: SessionRunnerLockClaimMarker, right: SessionRunnerLockClaimMarker): boolean {
  return left.v === right.v
    && left.generationId === right.generationId
    && left.claimantPid === right.claimantPid
    && left.claimantProcessCommandHash === right.claimantProcessCommandHash
    && left.claimantProcessStartTimeMs === right.claimantProcessStartTimeMs
    && left.createdAtMs === right.createdAtMs
    && left.nonce === right.nonce;
}

async function claimMarkerProcessIsStale(params: Readonly<{
  marker: SessionRunnerLockClaimMarker;
  readProcessRunState: (pid: number) => Promise<ProcessRunState>;
  readProcessIdentity: (pid: number) => ReturnType<typeof readSessionRunnerProcessIdentity>;
  readProcessStartTimeMs: ProcessStartTimeReader;
}>): Promise<boolean> {
  const holderState = await params.readProcessRunState(params.marker.claimantPid)
    .catch<ProcessRunState>(() => 'servable');
  if (holderState === 'dead' || holderState === 'zombie') return true;
  if (params.marker.claimantProcessCommandHash) {
    const currentIdentity = await params.readProcessIdentity(params.marker.claimantPid);
    if (storedProcessHashProvesPidReuse({
      storedProcessCommandHash: params.marker.claimantProcessCommandHash,
      currentIdentity,
    })) {
      return true;
    }
  }
  if (params.marker.claimantProcessStartTimeMs !== undefined) {
    const currentStartTimeMs = await Promise.resolve(
      params.readProcessStartTimeMs(params.marker.claimantPid),
    ).catch(() => null);
    return typeof currentStartTimeMs === 'number'
      && Number.isFinite(currentStartTimeMs)
      && Math.floor(currentStartTimeMs) !== params.marker.claimantProcessStartTimeMs;
  }
  return false;
}

async function claimSessionRunnerLockGeneration(params: Readonly<{
  lockPath: string;
  expected: SessionRunnerLockPayload;
  claimantPid: number;
  claimantProcessCommandHash: string | null;
  claimantProcessStartTimeMs: number | null;
  nowMs: number;
  claimStaleAfterMs: number;
  readProcessRunState: (pid: number) => Promise<ProcessRunState>;
  readProcessIdentity: (pid: number) => ReturnType<typeof readSessionRunnerProcessIdentity>;
  readProcessStartTimeMs: ProcessStartTimeReader;
}>): Promise<ClaimedSessionRunnerLock | null> {
  const generationKey = params.expected.generationId
    ?? `legacy-${params.expected.pid}-${params.expected.acquiredAtMs}`;
  const claimPath = `${params.lockPath}.${generationKey}.claim`;
  const ownedPath = `${claimPath}.${randomUUID()}.owned`;
  const marker: SessionRunnerLockClaimMarker = {
    v: 1,
    generationId: generationKey,
    claimantPid: params.claimantPid,
    ...(params.claimantProcessCommandHash
      ? { claimantProcessCommandHash: params.claimantProcessCommandHash }
      : {}),
    ...(params.claimantProcessStartTimeMs
      ? { claimantProcessStartTimeMs: params.claimantProcessStartTimeMs }
      : {}),
    createdAtMs: params.nowMs,
    nonce: randomUUID(),
  };
  const serializedMarker = JSON.stringify(marker, null, 2) + '\n';
  const writeClaim = async (): Promise<'created' | 'exists' | 'failed'> => {
    try {
      await writeFile(claimPath, serializedMarker, { encoding: 'utf8', flag: 'wx' });
      return 'created';
    } catch (error: any) {
      return error?.code === 'EEXIST' ? 'exists' : 'failed';
    }
  };
  let writeResult = await writeClaim();
  if (writeResult === 'exists') {
    let existingMarker: SessionRunnerLockClaimMarker | null = null;
    try {
      existingMarker = safeParseClaimMarker(await readFile(claimPath, 'utf8'));
    } catch {
      return null;
    }
    if (!existingMarker || existingMarker.generationId !== generationKey) return null;

    const markerAgeMs = params.nowMs - existingMarker.createdAtMs;
    if (markerAgeMs <= params.claimStaleAfterMs) return null;
    const markerIsStale = await claimMarkerProcessIsStale({
      marker: existingMarker,
      readProcessRunState: params.readProcessRunState,
      readProcessIdentity: params.readProcessIdentity,
      readProcessStartTimeMs: params.readProcessStartTimeMs,
    });
    if (!markerIsStale) return null;

    const staleOwnedPath = `${claimPath}.${randomUUID()}.stale`;
    try {
      await rename(claimPath, staleOwnedPath);
    } catch {
      return null;
    }
    const atomicallyClaimedStaleMarker = safeParseClaimMarker(
      await readFile(staleOwnedPath, 'utf8').catch(() => ''),
    );
    if (!atomicallyClaimedStaleMarker || !claimMarkerMatches(atomicallyClaimedStaleMarker, existingMarker)) {
      await rename(staleOwnedPath, claimPath).catch(() => undefined);
      return null;
    }
    writeResult = await writeClaim();
    await unlink(staleOwnedPath).catch(() => undefined);
  }
  if (writeResult !== 'created') return null;

  const releaseClaim = async () => {
    const releasedPath = `${claimPath}.${marker.nonce}.released`;
    try {
      await rename(claimPath, releasedPath);
      const releasedMarker = safeParseClaimMarker(await readFile(releasedPath, 'utf8'));
      if (!releasedMarker || !claimMarkerMatches(releasedMarker, marker)) {
        await rename(releasedPath, claimPath).catch(() => undefined);
        return;
      }
      await unlink(releasedPath).catch(() => undefined);
    } catch {
      // Another claimant may already have atomically recovered an expired claim.
    }
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
    const controlPort = Number(parsed?.controlPort);

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
      ...(Number.isInteger(controlPort) && controlPort >= 1 && controlPort <= 65_535
        ? { controlPort }
        : {}),
    };
  } catch {
    return null;
  }
}

function lifecycleStateMatches(
  left: SessionRunnerLifecycleState | null,
  right: SessionRunnerLifecycleState,
): boolean {
  return left !== null
    && left.sessionId === right.sessionId
    && left.pid === right.pid
    && left.generationId === right.generationId
    && left.phase === right.phase
    && left.phaseStartedAtMs === right.phaseStartedAtMs
    && left.heartbeatAtMs === right.heartbeatAtMs
    && left.cleanupDeadlineAtMs === right.cleanupDeadlineAtMs
    && left.cleanupOutcome === right.cleanupOutcome
    && left.cliVersion === right.cliVersion
    && left.runnerBuildId === right.runnerBuildId
    && left.controlPort === right.controlPort;
}

type OrphanedOwnedClaimReconciliation =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'restored' }>
  | Readonly<{ kind: 'blocked'; heldByPid: number }>;

async function reconcileOrphanedOwnedSessionRunnerClaim(params: Readonly<{
  lockPath: string;
  sessionId: string;
  nowMs: number;
  claimStaleAfterMs: number;
  readProcessRunState: (pid: number) => Promise<ProcessRunState>;
  readProcessIdentity: (pid: number) => ReturnType<typeof readSessionRunnerProcessIdentity>;
  readProcessStartTimeMs: ProcessStartTimeReader;
}>): Promise<OrphanedOwnedClaimReconciliation> {
  const directory = dirname(params.lockPath);
  const lockBasename = basename(params.lockPath);
  let candidateNames: string[];
  try {
    candidateNames = (await readdir(directory))
      .filter((name) => name.startsWith(`${lockBasename}.`) && name.endsWith('.owned'))
      .sort();
  } catch {
    return { kind: 'none' };
  }
  if (candidateNames.length === 0) return { kind: 'none' };
  if (candidateNames.length > 1) return { kind: 'blocked', heldByPid: 0 };

  const ownedPath = join(directory, candidateNames[0]!);
  const claimPath = ownedPath.replace(/\.[^.\\/]+\.owned$/u, '');
  if (claimPath === ownedPath || !claimPath.endsWith('.claim')) {
    return { kind: 'blocked', heldByPid: 0 };
  }
  const owned = safeParseLockPayload(await readFile(ownedPath, 'utf8').catch(() => ''));
  const marker = safeParseClaimMarker(await readFile(claimPath, 'utf8').catch(() => ''));
  if (!owned || !marker || owned.sessionId !== params.sessionId) {
    return { kind: 'blocked', heldByPid: marker?.claimantPid ?? owned?.pid ?? 0 };
  }
  const generationKey = owned.generationId ?? `legacy-${owned.pid}-${owned.acquiredAtMs}`;
  if (marker.generationId !== generationKey) {
    return { kind: 'blocked', heldByPid: marker.claimantPid };
  }
  if (params.nowMs - marker.createdAtMs <= params.claimStaleAfterMs) {
    return { kind: 'blocked', heldByPid: marker.claimantPid };
  }

  const claimantIsStale = await claimMarkerProcessIsStale({
    marker,
    readProcessRunState: params.readProcessRunState,
    readProcessIdentity: params.readProcessIdentity,
    readProcessStartTimeMs: params.readProcessStartTimeMs,
  });
  if (!claimantIsStale) {
    return { kind: 'blocked', heldByPid: marker.claimantPid };
  }

  try {
    await link(ownedPath, params.lockPath);
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      const canonical = safeParseLockPayload(
        await readFile(params.lockPath, 'utf8').catch(() => ''),
      );
      if (!canonical || canonical.sessionId !== params.sessionId) {
        return { kind: 'blocked', heldByPid: canonical?.pid ?? owned.pid };
      }
      const staleClaimPath = `${claimPath}.${randomUUID()}.stale`;
      try {
        await rename(claimPath, staleClaimPath);
        const atomicallyOwnedMarker = safeParseClaimMarker(
          await readFile(staleClaimPath, 'utf8').catch(() => ''),
        );
        if (!atomicallyOwnedMarker || !claimMarkerMatches(atomicallyOwnedMarker, marker)) {
          await rename(staleClaimPath, claimPath).catch(() => undefined);
          return { kind: 'blocked', heldByPid: marker.claimantPid };
        }
        try {
          await unlink(ownedPath);
        } catch {
          await rename(staleClaimPath, claimPath).catch(() => undefined);
          return { kind: 'blocked', heldByPid: owned.pid };
        }
        await unlink(staleClaimPath).catch(() => undefined);
        return { kind: 'restored' };
      } catch {
        return { kind: 'blocked', heldByPid: marker.claimantPid };
      }
    }
    return { kind: 'blocked', heldByPid: owned.pid };
  }
  const restored = safeParseLockPayload(await readFile(params.lockPath, 'utf8').catch(() => ''));
  if (!restored || !lockPayloadMatches(restored, owned)) {
    await unlink(params.lockPath).catch(() => undefined);
    return { kind: 'blocked', heldByPid: owned.pid };
  }
  await unlink(ownedPath).catch(() => undefined);

  const staleClaimPath = `${claimPath}.${randomUUID()}.stale`;
  try {
    await rename(claimPath, staleClaimPath);
    const atomicallyOwnedMarker = safeParseClaimMarker(
      await readFile(staleClaimPath, 'utf8').catch(() => ''),
    );
    if (!atomicallyOwnedMarker || !claimMarkerMatches(atomicallyOwnedMarker, marker)) {
      await rename(staleClaimPath, claimPath).catch(() => undefined);
      return { kind: 'blocked', heldByPid: marker.claimantPid };
    }
    await unlink(staleClaimPath).catch(() => undefined);
  } catch {
    return { kind: 'blocked', heldByPid: marker.claimantPid };
  }
  return { kind: 'restored' };
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
      setControlPort: (port: number) => Promise<boolean>;
      heartbeat: (nowMs?: number) => Promise<boolean>;
      markCleanup: (params?: Readonly<{
        nowMs?: number;
        deadlineAtMs?: number;
        isAttemptActive?: () => boolean;
      }>) => Promise<boolean>;
      readLifecycle: () => Promise<SessionRunnerLifecycleState | null>;
      release: (
        outcome?: SessionRunnerCleanupOutcome,
        options?: Readonly<{
          isAttemptActive?: () => boolean;
          tryCommitAttempt?: () => boolean;
        }>,
      ) => Promise<ReleaseSessionRunnerLockResult>;
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
  getCurrentProcessStartTimeMs?: ProcessStartTimeReader;
  killWedgedPid?: (pid: number) => void | Promise<void>;
  terminationConfirmTimeoutMs?: number;
  terminationConfirmPollMs?: number;
  claimStaleAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readNowMs?: () => number;
}>): Promise<AcquireSessionRunnerLockResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };

  const readNowMs = params.readNowMs ?? Date.now;
  const pid = typeof params.pid === 'number' && Number.isFinite(params.pid) && params.pid > 0 ? Math.floor(params.pid) : process.pid;
  const nowMsRaw = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : readNowMs();
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
  const readProcessStartTime = async (pidToRead: number): Promise<number | null> => {
    const raw = await Promise.resolve(
      params.getCurrentProcessStartTimeMs
        ? params.getCurrentProcessStartTimeMs(pidToRead)
        : params.getCurrentProcessCommandHash
          ? null
          : readProcessStartTimeMs(pidToRead),
    ).catch(() => null);
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : null;
  };
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readHolderRunState = async (pidToRead: number): Promise<ProcessRunState> =>
    await readProcessRunState(pidToRead).catch<ProcessRunState>(() => 'servable');
  const processIdentity = await readProcessIdentity(pid);
  const processCommandHash = processIdentity.kind === 'happy' ? processIdentity.processCommandHash : null;
  const processStartTimeMs = await readProcessStartTime(pid);
  const runnerBuildId = String(params.runnerBuildId ?? await resolveSessionRunnerBuildId() ?? '').trim();
  const claimStaleAfterMs = Math.max(1, Math.floor(params.claimStaleAfterMs ?? 30_000));

  const payload: SessionRunnerLockPayload = {
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    generationId,
    ...(processCommandHash ? { processCommandHash } : {}),
    ...(processStartTimeMs ? { processStartTimeMs } : {}),
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
    isAttemptActive: () => boolean = () => true,
  ): Promise<boolean> => {
    let updated = false;
    const nextWrite = lifecycleWriteChain.then(async () => {
      if (!isAttemptActive()) return;
      if (!(await lockStillOwned())) return;
      if (!isAttemptActive()) return;
      const current = await readLifecycle();
      if (!current) return;
      if (!isAttemptActive()) return;
      await writeFile(lifecyclePath, JSON.stringify(update(current), null, 2) + '\n', 'utf8');
      updated = true;
    });
    lifecycleWriteChain = nextWrite.catch(() => undefined);
    await nextWrite;
    return updated;
  };
  const setControlPort = async (port: number): Promise<boolean> => {
    const normalizedPort = Math.floor(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) return false;
    return await updateLifecycle((current) => ({
      ...current,
      controlPort: normalizedPort,
    }));
  };
  const heartbeat = async (heartbeatNowMs: number = readNowMs()): Promise<boolean> => {
    const normalizedNowMs = Math.max(1, Math.floor(heartbeatNowMs));
    return await updateLifecycle((current) => ({
      ...current,
      heartbeatAtMs: normalizedNowMs,
    }));
  };
  const markCleanup = async (
    cleanupParams: Readonly<{
      nowMs?: number;
      deadlineAtMs?: number;
      isAttemptActive?: () => boolean;
    }> = {},
  ): Promise<boolean> => {
    const cleanupNowMs = Math.max(1, Math.floor(cleanupParams.nowMs ?? readNowMs()));
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
    }), cleanupParams.isAttemptActive ?? (() => true));
  };
  const buildAcquiredResult = (): Extract<AcquireSessionRunnerLockResult, { ok: true }> => ({
    ok: true,
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    generationId,
    lockPath,
    setControlPort,
    heartbeat,
    markCleanup,
    readLifecycle,
    release: async (
      outcome: SessionRunnerCleanupOutcome = 'completed',
      options: Readonly<{
        isAttemptActive?: () => boolean;
        tryCommitAttempt?: () => boolean;
      }> = {},
    ) => {
      await lifecycleWriteChain;
      return await releaseSessionRunnerLock({
        happyHomeDir,
        sessionId,
        pid,
        acquiredAtMs: nowMs,
        generationId,
        cleanupOutcome: outcome,
        ...(params.getCurrentProcessCommandHash
          ? { getCurrentProcessCommandHash: params.getCurrentProcessCommandHash }
          : {}),
        ...(params.getCurrentProcessStartTimeMs
          ? { getCurrentProcessStartTimeMs: params.getCurrentProcessStartTimeMs }
          : {}),
        ...(params.readProcessRunState
          ? { readProcessRunState: params.readProcessRunState }
          : {}),
        claimStaleAfterMs,
        ...(options.isAttemptActive ? { isAttemptActive: options.isAttemptActive } : {}),
        ...(options.tryCommitAttempt
          ? { tryCommitAttempt: options.tryCommitAttempt }
          : {}),
      });
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
      const failedClaim = await claimSessionRunnerLockGeneration({
        lockPath,
        expected: payload,
        claimantPid: pid,
        claimantProcessCommandHash: processCommandHash,
        claimantProcessStartTimeMs: processStartTimeMs,
        nowMs,
        claimStaleAfterMs,
        readProcessRunState: readHolderRunState,
        readProcessIdentity,
        readProcessStartTimeMs: readProcessStartTime,
      });
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

  const orphanedOwnedClaim = await reconcileOrphanedOwnedSessionRunnerClaim({
    lockPath,
    sessionId,
    nowMs,
    claimStaleAfterMs,
    readProcessRunState: readHolderRunState,
    readProcessIdentity,
    readProcessStartTimeMs: readProcessStartTime,
  });
  if (orphanedOwnedClaim.kind === 'blocked') {
    return {
      ok: false,
      reason: 'already_running',
      heldByPid: orphanedOwnedClaim.heldByPid,
    };
  }

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

  const killWedgedPid = params.killWedgedPid ?? killWedgedPidDefault;
  const sleep = params.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  const terminationConfirmTimeoutMs = Math.max(1, Math.floor(params.terminationConfirmTimeoutMs ?? 5_000));
  const terminationConfirmPollMs = Math.max(1, Math.floor(params.terminationConfirmPollMs ?? 25));
  const terminateAndConfirmOriginalHolder = async (
    holder: SessionRunnerLockPayload,
  ): Promise<boolean> => {
    const immediateIdentity = await readProcessIdentity(holder.pid);
    const immediateStartTimeMs = await readProcessStartTime(holder.pid);
    if (
      !storedProcessHashMatchesCurrentIdentity({
        storedProcessCommandHash: holder.processCommandHash,
        currentIdentity: immediateIdentity,
      })
      || holder.processStartTimeMs === undefined
      || immediateStartTimeMs !== holder.processStartTimeMs
    ) {
      return false;
    }
    try {
      await killWedgedPid(holder.pid);
    } catch {
      return false;
    }
    const deadlineAtMs = readNowMs() + terminationConfirmTimeoutMs;
    while (true) {
      const state = await readHolderRunState(holder.pid);
      if (state === 'dead' || state === 'zombie') return true;
      const identity = await readProcessIdentity(holder.pid);
      const currentStartTimeMs = await readProcessStartTime(holder.pid);
      if (currentStartTimeMs !== null && currentStartTimeMs !== holder.processStartTimeMs) {
        return true;
      }
      if (!storedProcessHashMatchesCurrentIdentity({
        storedProcessCommandHash: holder.processCommandHash,
        currentIdentity: identity,
      }) || currentStartTimeMs !== holder.processStartTimeMs) {
        return false;
      }
      if (readNowMs() >= deadlineAtMs) return false;
      await sleep(Math.min(terminationConfirmPollMs, Math.max(1, deadlineAtMs - readNowMs())));
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
      const currentStartTimeMs = await readProcessStartTime(existing.pid);
      const startTimeProvesPidReuse = existing.processStartTimeMs !== undefined
        && currentStartTimeMs !== null
        && existing.processStartTimeMs !== currentStartTimeMs;
      if (storedProcessHashProvesPidReuse({
        storedProcessCommandHash: existing.processCommandHash,
        currentIdentity,
      }) || startTimeProvesPidReuse) {
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
  const claimed = await claimSessionRunnerLockGeneration({
    lockPath,
    expected: existing,
    claimantPid: pid,
    claimantProcessCommandHash: processCommandHash,
    claimantProcessStartTimeMs: processStartTimeMs,
    nowMs,
    claimStaleAfterMs,
    readProcessRunState: readHolderRunState,
    readProcessIdentity,
    readProcessStartTimeMs: readProcessStartTime,
  });
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
  | Readonly<{ ok: false; reason: 'attempt_inactive' }>
  | Readonly<{ ok: false; reason: 'io_error'; errorMessage: string }>;

export async function releaseSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  generationId?: string;
  nowMs?: number;
  cleanupOutcome?: SessionRunnerCleanupOutcome;
  happyHomeDir?: string;
  isAttemptActive?: () => boolean;
  tryCommitAttempt?: () => boolean;
  getCurrentProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getCurrentProcessStartTimeMs?: ProcessStartTimeReader;
  readProcessRunState?: (pid: number) => Promise<ProcessRunState>;
  claimStaleAfterMs?: number;
}>): Promise<ReleaseSessionRunnerLockResult> {
  const isAttemptActive = params.isAttemptActive ?? (() => true);
  if (!isAttemptActive()) return { ok: false, reason: 'attempt_inactive' };
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
  if (!isAttemptActive()) return { ok: false, reason: 'attempt_inactive' };

  if (!existing) return { ok: false, reason: 'not_owner' };
  if (existing.sessionId !== sessionId) return { ok: false, reason: 'not_owner' };
  if (existing.pid !== params.pid) return { ok: false, reason: 'not_owner' };
  if (existing.acquiredAtMs !== params.acquiredAtMs) return { ok: false, reason: 'not_owner' };
  if (existing.generationId && existing.generationId !== params.generationId) {
    return { ok: false, reason: 'not_owner' };
  }

  const releaseNowMs = Math.max(1, Math.floor(params.nowMs ?? Date.now()));
  const releaseIdentity = async (pidToRead: number) =>
    await readSessionRunnerProcessIdentity({
      pid: pidToRead,
      getProcessCommandHash: params.getCurrentProcessCommandHash,
    });
  const currentReleaseIdentity = await releaseIdentity(params.pid);
  const releaseStartTime = async (pidToRead: number): Promise<number | null> => {
    const raw = await Promise.resolve(
      params.getCurrentProcessStartTimeMs
        ? params.getCurrentProcessStartTimeMs(pidToRead)
        : readProcessStartTimeMs(pidToRead),
    ).catch(() => null);
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : null;
  };
  const currentReleaseStartTimeMs = await releaseStartTime(params.pid);
  if (!isAttemptActive()) return { ok: false, reason: 'attempt_inactive' };
  const claimed = await claimSessionRunnerLockGeneration({
    lockPath,
    expected: existing,
    claimantPid: params.pid,
    claimantProcessCommandHash: currentReleaseIdentity.kind === 'happy'
      ? currentReleaseIdentity.processCommandHash
      : null,
    claimantProcessStartTimeMs: currentReleaseStartTimeMs,
    nowMs: releaseNowMs,
    claimStaleAfterMs: Math.max(1, Math.floor(params.claimStaleAfterMs ?? 30_000)),
    readProcessRunState: async (pidToRead) =>
      await (params.readProcessRunState ?? readProcessRunStateDefault)(pidToRead)
        .catch<ProcessRunState>(() => 'servable'),
    readProcessIdentity: releaseIdentity,
    readProcessStartTimeMs: releaseStartTime,
  });
  if (!claimed) return { ok: false, reason: 'not_owner' };
  let preserveClaimForRecovery = false;
  const restoreClaimedOwnership = async (): Promise<boolean> => {
    try {
      await rename(claimed.ownedPath, lockPath);
      return true;
    } catch {
      preserveClaimForRecovery = true;
      return false;
    }
  };
  if (!isAttemptActive()) {
    const restored = await restoreClaimedOwnership();
    if (!preserveClaimForRecovery) await claimed.releaseClaim();
    return restored
      ? { ok: false, reason: 'attempt_inactive' }
      : { ok: false, reason: 'io_error', errorMessage: 'Failed to restore runner ownership after lifecycle attempt expired' };
  }
  let restoreLifecycleState: (() => Promise<boolean>) | null = null;
  const restoreFailedRelease = async (
    errorMessage: string,
    inactiveAttempt: boolean = false,
  ): Promise<ReleaseSessionRunnerLockResult> => {
    const lifecycleRestored = restoreLifecycleState
      ? await restoreLifecycleState()
      : true;
    const ownershipRestored = await restoreClaimedOwnership();
    if (!lifecycleRestored || !ownershipRestored) {
      preserveClaimForRecovery = true;
      return {
        ok: false,
        reason: 'io_error',
        errorMessage: 'Failed to restore runner ownership or lifecycle after unconfirmed release',
      };
    }
    return inactiveAttempt
      ? { ok: false, reason: 'attempt_inactive' }
      : { ok: false, reason: 'io_error', errorMessage };
  };

  try {
    if (existing.generationId) {
      const lifecyclePath = sessionRunnerLifecyclePathForGeneration({
        happyHomeDir,
        sessionId,
        generationId: existing.generationId,
      });
      if (lifecyclePath) {
        const current = await readSessionRunnerLifecycleState({
          happyHomeDir,
          sessionId,
          generationId: existing.generationId,
        });
        if (!current) {
          return await restoreFailedRelease(
            'Runner lifecycle state unavailable; cleanup outcome was not confirmed',
          );
        }
        if (!isAttemptActive()) {
          return await restoreFailedRelease(
            'Runner release attempt expired before lifecycle persistence',
            true,
          );
        }
        restoreLifecycleState = async () => {
          try {
            await writeFile(lifecyclePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
            const restored = await readSessionRunnerLifecycleState({
              happyHomeDir,
              sessionId,
              generationId: existing.generationId!,
            });
            return lifecycleStateMatches(restored, current);
          } catch {
            return false;
          }
        };
        const finished: SessionRunnerLifecycleState = {
          ...current,
          phase: 'finished',
          phaseStartedAtMs: releaseNowMs,
          heartbeatAtMs: releaseNowMs,
          cleanupOutcome: params.cleanupOutcome ?? 'completed',
        };
        await writeFile(lifecyclePath, JSON.stringify(finished, null, 2) + '\n', 'utf8');
        const persistedFinished = await readSessionRunnerLifecycleState({
          happyHomeDir,
          sessionId,
          generationId: existing.generationId,
        });
        if (!lifecycleStateMatches(persistedFinished, finished)) {
          return await restoreFailedRelease(
            'Runner lifecycle cleanup outcome could not be verified',
          );
        }
        if (!isAttemptActive()) {
          return await restoreFailedRelease(
            'Runner release attempt expired after lifecycle persistence',
            true,
          );
        }
      }
    }
    if (!isAttemptActive()) {
      return await restoreFailedRelease(
        'Runner release attempt expired before ownership unlink',
        true,
      );
    }
    if (params.tryCommitAttempt && !params.tryCommitAttempt()) {
      return await restoreFailedRelease(
        'Runner lifecycle release commit expired',
        true,
      );
    }
    await unlink(claimed.ownedPath);
    return { ok: true };
  } catch (e: any) {
    return await restoreFailedRelease(
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    if (!preserveClaimForRecovery) await claimed.releaseClaim();
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

export type QuarantineSessionRunnerGenerationReason =
  | 'control_challenge_failed'
  | 'heartbeat_stale'
  | 'runner_not_serving'
  | 'pid_identity_reused';

export type QuarantineSessionRunnerGenerationResult =
  | Readonly<{
      ok: true;
      generationId: string;
      quarantinePath: string;
      lifecycleQuarantinePath?: string;
    }>
  | Readonly<{
      ok: false;
      reason:
        | 'invalid_request'
        | 'not_found'
        | 'generation_changed'
        | 'unsafe_holder'
        | 'termination_failed'
        | 'claim_failed'
        | 'io_error';
      errorMessage?: string;
    }>;

/**
 * Atomically removes one proven generation from the canonical runner-lock slot.
 *
 * The claim marker fences concurrent acquisition while the exact holder identity is
 * rechecked and, when necessary, terminated. If identity cannot be proven, ownership
 * is restored and the caller must continue to fail closed.
 */
export async function quarantineSessionRunnerGeneration(params: Readonly<{
  sessionId: string;
  expectedGenerationId: string;
  reason: QuarantineSessionRunnerGenerationReason;
  happyHomeDir?: string;
  nowMs?: number;
  readNowMs?: () => number;
  readProcessRunState?: (pid: number) => Promise<ProcessRunState>;
  getCurrentProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getCurrentProcessStartTimeMs?: ProcessStartTimeReader;
  killRunnerPid?: (pid: number) => void | Promise<void>;
  terminationConfirmTimeoutMs?: number;
  terminationConfirmPollMs?: number;
  claimStaleAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<QuarantineSessionRunnerGenerationResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  const expectedGenerationId = String(params.expectedGenerationId ?? '').trim();
  if (!sessionId || !/^[A-Za-z0-9._-]{8,128}$/.test(expectedGenerationId)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_request' };

  let expected: SessionRunnerLockPayload | null = null;
  try {
    expected = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return {
      ok: false,
      reason: 'io_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (!expected || expected.sessionId !== sessionId) {
    return { ok: false, reason: 'io_error', errorMessage: 'Canonical runner lock payload is invalid' };
  }
  if (expected.generationId !== expectedGenerationId) {
    return { ok: false, reason: 'generation_changed' };
  }

  const readNowMs = params.readNowMs ?? Date.now;
  const nowMs = Math.max(1, Math.floor(params.nowMs ?? readNowMs()));
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readHolderRunState = async (pid: number): Promise<ProcessRunState> =>
    await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  const readProcessIdentity = async (pid: number) =>
    await readSessionRunnerProcessIdentity({
      pid,
      getProcessCommandHash: params.getCurrentProcessCommandHash,
    });
  const readProcessStartTime = async (pid: number): Promise<number | null> => {
    const value = await Promise.resolve(
      params.getCurrentProcessStartTimeMs
        ? params.getCurrentProcessStartTimeMs(pid)
        : params.getCurrentProcessCommandHash
          ? null
          : readProcessStartTimeMs(pid),
    ).catch(() => null);
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : null;
  };

  const claimantIdentity = await readProcessIdentity(process.pid);
  const claimantProcessCommandHash = claimantIdentity.kind === 'happy'
    ? claimantIdentity.processCommandHash
    : null;
  const claimantProcessStartTimeMs = await readProcessStartTime(process.pid);
  const claimed = await claimSessionRunnerLockGeneration({
    lockPath,
    expected,
    claimantPid: process.pid,
    claimantProcessCommandHash,
    claimantProcessStartTimeMs,
    nowMs,
    claimStaleAfterMs: Math.max(1, Math.floor(params.claimStaleAfterMs ?? 30_000)),
    readProcessRunState: readHolderRunState,
    readProcessIdentity,
    readProcessStartTimeMs: readProcessStartTime,
  });
  if (!claimed) {
    const current = await readSessionRunnerLockStatus({ happyHomeDir, sessionId }).catch(() => null);
    if (current?.ok && current.lock.generationId !== expectedGenerationId) {
      return { ok: false, reason: 'generation_changed' };
    }
    return { ok: false, reason: 'claim_failed' };
  }

  const restoreOwnedGeneration = async (): Promise<boolean> => {
    try {
      await rename(claimed.ownedPath, lockPath);
      const restored = safeParseLockPayload(await readFile(lockPath, 'utf8'));
      return restored !== null && lockPayloadMatches(restored, expected);
    } catch {
      return false;
    }
  };

  try {
    const holderState = await readHolderRunState(expected.pid);
    if (holderState !== 'dead' && holderState !== 'zombie') {
      const currentIdentity = await readProcessIdentity(expected.pid);
      const currentStartTimeMs = await readProcessStartTime(expected.pid);
      const startTimeProvesPidReuse = expected.processStartTimeMs !== undefined
        && currentStartTimeMs !== null
        && expected.processStartTimeMs !== currentStartTimeMs;
      const identityProvesPidReuse = storedProcessHashProvesPidReuse({
        storedProcessCommandHash: expected.processCommandHash,
        currentIdentity,
      });

      if (!startTimeProvesPidReuse && !identityProvesPidReuse) {
        const exactHolder = storedProcessHashMatchesCurrentIdentity({
          storedProcessCommandHash: expected.processCommandHash,
          currentIdentity,
        })
          && expected.processStartTimeMs !== undefined
          && currentStartTimeMs === expected.processStartTimeMs;
        if (!exactHolder) {
          await restoreOwnedGeneration();
          return { ok: false, reason: 'unsafe_holder' };
        }

        try {
          await (params.killRunnerPid ?? killWedgedPidDefault)(expected.pid);
        } catch {
          await restoreOwnedGeneration();
          return { ok: false, reason: 'termination_failed' };
        }

        const sleep = params.sleep
          ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
        const confirmTimeoutMs = Math.max(1, Math.floor(params.terminationConfirmTimeoutMs ?? 5_000));
        const confirmPollMs = Math.max(1, Math.floor(params.terminationConfirmPollMs ?? 25));
        const deadlineAtMs = readNowMs() + confirmTimeoutMs;
        let holderTerminated = false;
        while (true) {
          const state = await readHolderRunState(expected.pid);
          if (state === 'dead' || state === 'zombie') {
            holderTerminated = true;
            break;
          }
          const identity = await readProcessIdentity(expected.pid);
          const startTimeMs = await readProcessStartTime(expected.pid);
          if (
            storedProcessHashProvesPidReuse({
              storedProcessCommandHash: expected.processCommandHash,
              currentIdentity: identity,
            })
            || (
              expected.processStartTimeMs !== undefined
              && startTimeMs !== null
              && startTimeMs !== expected.processStartTimeMs
            )
          ) {
            holderTerminated = true;
            break;
          }
          if (readNowMs() >= deadlineAtMs) break;
          await sleep(Math.min(confirmPollMs, Math.max(1, deadlineAtMs - readNowMs())));
        }
        if (!holderTerminated) {
          await restoreOwnedGeneration();
          return { ok: false, reason: 'termination_failed' };
        }
      }
    }

    const quarantineSuffix = `${params.reason}.${nowMs}.${randomUUID()}.quarantined`;
    const quarantinePath = `${lockPath}.${quarantineSuffix}`;
    await rename(claimed.ownedPath, quarantinePath);

    const lifecyclePath = sessionRunnerLifecyclePathForGeneration({
      happyHomeDir,
      sessionId,
      generationId: expectedGenerationId,
    });
    let lifecycleQuarantinePath: string | undefined;
    if (lifecyclePath) {
      const candidate = `${lifecyclePath}.${quarantineSuffix}`;
      try {
        await rename(lifecyclePath, candidate);
        lifecycleQuarantinePath = candidate;
      } catch {
        // The canonical lock has already been safely isolated. Missing lifecycle
        // evidence must not restore a stale owner into the active slot.
      }
    }

    return {
      ok: true,
      generationId: expectedGenerationId,
      quarantinePath,
      ...(lifecycleQuarantinePath ? { lifecycleQuarantinePath } : {}),
    };
  } catch (error) {
    await restoreOwnedGeneration();
    return {
      ok: false,
      reason: 'io_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await claimed.releaseClaim();
  }
}
