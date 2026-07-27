import type { ProcessRunState } from '@/daemon/processRunState';
import type { DoctorRuntimeDiagnostic } from '@happier-dev/protocol';
import {
  isSessionRunnerLifecycleAuthoritativelyStale,
  type SessionRunnerLifecycleState,
} from '@/daemon/sessionRunnerLifecycleState';
import type { SessionRunnerLockPayload } from '@/daemon/sessionRunnerLock';
import { inspectServerProfileUrlRoles } from '@/server/serverProfileUrlRoles';

export type RunnerDoctorDiagnostic = DoctorRuntimeDiagnostic;

export type RunnerDoctorDiagnosticInput = Readonly<{
  nowMs: number;
  heartbeatTimeoutMs: number;
  currentCliVersion: string;
  currentRunnerBuildId: string | null;
  machineId?: string | null;
  runners: readonly Readonly<{
    sessionActive: boolean | null;
    processState: ProcessRunState;
    lock: SessionRunnerLockPayload;
    lifecycle: SessionRunnerLifecycleState | null;
    log?: Readonly<{
      fileName: string;
      lastWriteAtMs: number;
    }> | null;
  }>[];
  mutationDeadLetters: readonly Readonly<{
    fileName: string;
    sessionIds: readonly string[];
    entryCount: number;
  }>[];
  serverRoles: Readonly<{
    serverId: string;
    resolvedServerUrl: string;
    resolvedWebappUrl: string;
    profileServerUrl: string;
    profileLocalServerUrl?: string | null;
    profileWebappUrl: string;
  }> | null;
}>;

type RunnerInput = RunnerDoctorDiagnosticInput['runners'][number];

const RUNNER_RECOVERY_RECOMMENDATION =
  'Restart the Happier daemon, then resume the session so a fresh runner generation can take ownership; do not delete the lock manually.';
const VERSION_RECOVERY_RECOMMENDATION =
  'Restart the Happier daemon and resume the session so the runner uses the current CLI build.';
const DEAD_LETTER_RECOVERY_RECOMMENDATION =
  'Inspect and preserve the mutation dead-letter, restore relay connectivity, then replay or explicitly isolate the failed mutations.';

function buildRunnerRecoveryContext(
  input: RunnerDoctorDiagnosticInput,
  runner: RunnerInput,
  recoveryRecommendation: string,
) {
  return {
    machineId: String(input.machineId ?? '').trim() || null,
    sessionId: runner.lock.sessionId,
    pid: runner.lock.pid,
    generationId: runner.lock.generationId ?? null,
    processState: runner.processState,
    lastHeartbeatAtMs: runner.lifecycle?.heartbeatAtMs ?? null,
    cleanupPhase: runner.lifecycle?.phase ?? 'unknown',
    recoveryRecommendation,
  } as const;
}

function comparableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(raw ?? '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

function urlPort(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return null;
  }
}

function urlHost(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function buildRunnerDoctorDiagnostics(
  input: RunnerDoctorDiagnosticInput,
): readonly RunnerDoctorDiagnostic[] {
  const findings: RunnerDoctorDiagnostic[] = [];

  for (const runner of input.runners) {
    const lifecycleStale = isSessionRunnerLifecycleAuthoritativelyStale({
      lifecycle: runner.lifecycle,
      nowMs: input.nowMs,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs,
    });

    if (runner.sessionActive === false) {
      const lockState = lifecycleStale
        || runner.processState === 'dead'
        || runner.processState === 'stopped'
        || runner.processState === 'zombie'
        ? 'stale'
        : runner.lock.generationId && !runner.lifecycle
          ? 'unknown'
          : 'live';
      findings.push({
        code: 'inactive_session_runner_lock',
        severity: 'warning',
        data: {
          ...buildRunnerRecoveryContext(input, runner, RUNNER_RECOVERY_RECOMMENDATION),
          lockState,
        },
      });
    }

    if (
      runner.lifecycle?.phase === 'cleanup'
      && typeof runner.lifecycle.cleanupDeadlineAtMs === 'number'
      && input.nowMs > runner.lifecycle.cleanupDeadlineAtMs
    ) {
      findings.push({
        code: 'runner_cleanup_overdue',
        severity: 'warning',
        data: {
          ...buildRunnerRecoveryContext(input, runner, RUNNER_RECOVERY_RECOMMENDATION),
          deadlineAtMs: runner.lifecycle.cleanupDeadlineAtMs,
          overdueByMs: input.nowMs - runner.lifecycle.cleanupDeadlineAtMs,
        },
      });
    }

    if (runner.lock.generationId && !runner.lifecycle) {
      findings.push({
        code: 'runner_heartbeat_stale',
        severity: 'warning',
        data: {
          ...buildRunnerRecoveryContext(input, runner, RUNNER_RECOVERY_RECOMMENDATION),
          heartbeatState: 'missing',
          heartbeatAgeMs: null,
        },
      });
    } else if (
      runner.lifecycle
      && input.nowMs - runner.lifecycle.heartbeatAtMs > input.heartbeatTimeoutMs
    ) {
      findings.push({
        code: 'runner_heartbeat_stale',
        severity: 'warning',
        data: {
          ...buildRunnerRecoveryContext(input, runner, RUNNER_RECOVERY_RECOMMENDATION),
          heartbeatState: 'stale',
          heartbeatAgeMs: input.nowMs - runner.lifecycle.heartbeatAtMs,
        },
      });
    }

    if (runner.sessionActive === false && runner.log !== undefined) {
      const lastWriteAtMs = runner.log?.lastWriteAtMs ?? null;
      const logAgeMs = lastWriteAtMs === null
        ? null
        : Math.max(0, input.nowMs - lastWriteAtMs);
      const logState = runner.log === null
        ? 'missing'
        : logAgeMs !== null && logAgeMs > input.heartbeatTimeoutMs
          ? 'stale'
          : 'fresh';
      if (logState !== 'fresh') {
        findings.push({
          code: 'runner_log_stale',
          severity: 'warning',
          data: {
            ...buildRunnerRecoveryContext(input, runner, RUNNER_RECOVERY_RECOMMENDATION),
            logState,
            fileName: runner.log?.fileName ?? null,
            lastLogWriteAtMs: lastWriteAtMs,
            logAgeMs,
          },
        });
      }
    }

    if (runner.lifecycle) {
      const versionDrift = runner.lifecycle.cliVersion !== input.currentCliVersion;
      const buildDrift = Boolean(
        runner.lifecycle.runnerBuildId
        && input.currentRunnerBuildId
        && runner.lifecycle.runnerBuildId !== input.currentRunnerBuildId,
      );
      if (versionDrift || buildDrift) {
        findings.push({
          code: 'runner_cli_build_drift',
          severity: 'warning',
          data: {
            ...buildRunnerRecoveryContext(input, runner, VERSION_RECOVERY_RECOMMENDATION),
            runnerCliVersion: runner.lifecycle.cliVersion,
            currentCliVersion: input.currentCliVersion,
            runnerBuildId: runner.lifecycle.runnerBuildId ?? null,
            currentRunnerBuildId: input.currentRunnerBuildId,
          },
        });
      }
    }
  }

  for (const deadLetter of input.mutationDeadLetters) {
    if (deadLetter.entryCount <= 0) continue;
    findings.push({
      code: 'session_mutation_dead_letter',
      severity: 'warning',
      data: {
        machineId: String(input.machineId ?? '').trim() || null,
        fileName: deadLetter.fileName,
        sessionIds: [...deadLetter.sessionIds],
        entryCount: deadLetter.entryCount,
        recoveryRecommendation: DEAD_LETTER_RECOVERY_RECOMMENDATION,
      },
    });
  }

  if (input.serverRoles) {
    const roles = input.serverRoles;
    const driftKinds: ('role' | 'port' | 'same_endpoint')[] = [];
    const roleConflict = inspectServerProfileUrlRoles({
      serverUrl: roles.profileServerUrl,
      localServerUrl: roles.profileLocalServerUrl,
      webappUrl: roles.profileWebappUrl,
    });
    if (roleConflict) driftKinds.push('same_endpoint');

    const rolesSwapped = comparableUrl(roles.resolvedServerUrl) === comparableUrl(roles.profileWebappUrl)
      && comparableUrl(roles.resolvedWebappUrl) === comparableUrl(roles.profileServerUrl)
      && comparableUrl(roles.profileServerUrl) !== comparableUrl(roles.profileWebappUrl);
    if (rolesSwapped) driftKinds.push('role');

    const serverPortDrift = urlHost(roles.resolvedServerUrl) === urlHost(roles.profileServerUrl)
      && urlPort(roles.resolvedServerUrl) !== urlPort(roles.profileServerUrl);
    const webappPortDrift = urlHost(roles.resolvedWebappUrl) === urlHost(roles.profileWebappUrl)
      && urlPort(roles.resolvedWebappUrl) !== urlPort(roles.profileWebappUrl);
    if (!rolesSwapped && (serverPortDrift || webappPortDrift)) driftKinds.push('port');

    if (driftKinds.length > 0) {
      findings.push({
        code: 'server_webapp_role_port_drift',
        severity: roleConflict || rolesSwapped ? 'error' : 'warning',
        data: {
          ...roles,
          profileLocalServerUrl: roles.profileLocalServerUrl ?? null,
          driftKinds,
          recoveryRecommendation:
            `Set distinct relay and web app URLs for server profile ${roles.serverId}, then reselect that server profile.`,
        },
      });
    }
  }

  return findings;
}
