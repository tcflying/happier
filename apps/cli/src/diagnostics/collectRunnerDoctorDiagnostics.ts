import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { configuration } from '@/configuration';
import { listDaemonSessions } from '@/daemon/controlClient';
import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';
import { resolveSessionRunnerBuildId } from '@/daemon/sessionRunnerBuildId';
import {
  readSessionRunnerLockStatus,
  SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS,
  type SessionRunnerLifecycleState,
  type SessionRunnerLockPayload,
} from '@/daemon/sessionRunnerLock';
import type { Settings } from '@/persistence';

import { buildRunnerDoctorDiagnostics, type RunnerDoctorDiagnostic } from './runnerDoctorDiagnostics';

async function listJsonFiles(directory: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function collectMutationDeadLetters(activeServerDir: string): Promise<ReadonlyArray<{
  fileName: string;
  sessionIds: readonly string[];
  entryCount: number;
}>> {
  const files = await listJsonFiles(join(activeServerDir, 'session-mutations'), '.dead-letter.json');
  const results = await Promise.all(files.map(async (filePath) => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      const entries: unknown[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const sessionIds = Array.from(new Set<string>(entries.reduce<string[]>((result, entry: unknown) => {
        const sessionId = entry
          && typeof entry === 'object'
          && typeof (entry as { sessionId?: unknown }).sessionId === 'string'
          ? String((entry as { sessionId: string }).sessionId).trim()
          : '';
        if (sessionId) result.push(sessionId);
        return result;
      }, []))).sort();
      return {
        fileName: basename(filePath),
        sessionIds,
        entryCount: entries.length,
      };
    } catch {
      return null;
    }
  }));
  return results.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

async function collectSessionRunnerLogsByPid(logsDir: string): Promise<ReadonlyMap<number, Readonly<{
  fileName: string;
  lastWriteAtMs: number;
}>>> {
  let entries: Dirent[];
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = entry.name.match(/-pid-(\d+)\.log$/);
    if (!match) return [];
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0
      ? [{ pid, fileName: entry.name, filePath: join(logsDir, entry.name) }]
      : [];
  });
  const inspected = await Promise.all(candidates.map(async (candidate) => {
    try {
      const fileStat = await stat(candidate.filePath);
      return {
        pid: candidate.pid,
        fileName: candidate.fileName,
        lastWriteAtMs: Math.max(0, Math.floor(fileStat.mtimeMs)),
      };
    } catch {
      return null;
    }
  }));

  const byPid = new Map<number, Readonly<{ fileName: string; lastWriteAtMs: number }>>();
  for (const candidate of inspected) {
    if (!candidate) continue;
    const current = byPid.get(candidate.pid);
    if (!current || candidate.lastWriteAtMs > current.lastWriteAtMs) {
      byPid.set(candidate.pid, {
        fileName: candidate.fileName,
        lastWriteAtMs: candidate.lastWriteAtMs,
      });
    }
  }
  return byPid;
}

async function collectRunnerLocks(params: Readonly<{
  happyHomeDir: string;
  activeSessionIds: ReadonlySet<string>;
  sessionInventoryKnown: boolean;
}>): Promise<ReadonlyArray<{
  sessionActive: boolean | null;
  processState: ProcessRunState;
  lock: SessionRunnerLockPayload;
  lifecycle: SessionRunnerLifecycleState | null;
}>> {
  const directory = join(params.happyHomeDir, 'tmp', 'session-runner-locks');
  const files = (await listJsonFiles(directory, '.json'))
    .filter((filePath) => !filePath.endsWith('.lifecycle.json'));
  const statuses = await Promise.all(files.map(async (filePath) => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : '';
      if (!sessionId) return null;
      const status = await readSessionRunnerLockStatus({
        happyHomeDir: params.happyHomeDir,
        sessionId,
      });
      if (!status.ok) return null;
      return {
        sessionActive: params.sessionInventoryKnown ? params.activeSessionIds.has(sessionId) : null,
        processState: await readProcessRunState(status.lock.pid),
        lock: status.lock,
        lifecycle: status.lifecycle ?? null,
      };
    } catch {
      return null;
    }
  }));
  return statuses.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export async function collectRunnerDoctorDiagnostics(params: Readonly<{
  settings: Settings;
  nowMs?: number;
}>): Promise<readonly RunnerDoctorDiagnostic[]> {
  let sessionInventoryKnown = true;
  const sessions = await listDaemonSessions().catch(() => {
    sessionInventoryKnown = false;
    return [];
  });
  const activeSessionIds = new Set(sessions
    .map((session) => typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '')
    .filter(Boolean));
  const [runnerLocks, mutationDeadLetters, currentRunnerBuildId, runnerLogsByPid] = await Promise.all([
    collectRunnerLocks({
      happyHomeDir: configuration.happyHomeDir,
      activeSessionIds,
      sessionInventoryKnown,
    }),
    collectMutationDeadLetters(configuration.activeServerDir),
    resolveSessionRunnerBuildId(),
    collectSessionRunnerLogsByPid(configuration.logsDir),
  ]);
  const runners = runnerLocks.map((runner) => {
    const log = runnerLogsByPid.get(runner.lock.pid) ?? null;
    return {
      ...runner,
      log: log && log.lastWriteAtMs >= runner.lock.acquiredAtMs ? log : null,
    };
  });
  const activeProfile = params.settings.servers?.[configuration.activeServerId] ?? null;
  const machineId = String(
    params.settings.machineIdByServerId?.[configuration.activeServerId]
    ?? params.settings.machineId
    ?? '',
  ).trim() || null;

  return buildRunnerDoctorDiagnostics({
    nowMs: Math.max(1, Math.floor(params.nowMs ?? Date.now())),
    heartbeatTimeoutMs: SESSION_RUNNER_HEARTBEAT_TIMEOUT_MS,
    currentCliVersion: configuration.currentCliVersion,
    currentRunnerBuildId,
    machineId,
    runners,
    mutationDeadLetters,
    serverRoles: activeProfile
      ? {
        serverId: activeProfile.id,
        resolvedServerUrl: configuration.serverUrl,
        resolvedWebappUrl: configuration.webappUrl,
        profileServerUrl: activeProfile.serverUrl,
        profileLocalServerUrl: activeProfile.localServerUrl ?? null,
        profileWebappUrl: activeProfile.webappUrl,
      }
      : null,
  });
}
