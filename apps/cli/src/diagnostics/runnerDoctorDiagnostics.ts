import type { ProcessRunState } from '@/daemon/processRunState';
import type { DoctorRuntimeDiagnostic } from '@happier-dev/protocol';
import {
  isSessionRunnerLifecycleAuthoritativelyStale,
  type SessionRunnerLifecycleState,
  type SessionRunnerLockPayload,
} from '@/daemon/sessionRunnerLock';

export type RunnerDoctorDiagnostic = DoctorRuntimeDiagnostic;

export type RunnerDoctorDiagnosticInput = Readonly<{
  nowMs: number;
  heartbeatTimeoutMs: number;
  currentCliVersion: string;
  currentRunnerBuildId: string | null;
  runners: readonly Readonly<{
    sessionActive: boolean;
    processState: ProcessRunState;
    lock: SessionRunnerLockPayload;
    lifecycle: SessionRunnerLifecycleState | null;
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
    profileWebappUrl: string;
  }> | null;
}>;

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

    if (!runner.sessionActive) {
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
          sessionId: runner.lock.sessionId,
          pid: runner.lock.pid,
          generationId: runner.lock.generationId ?? null,
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
          sessionId: runner.lock.sessionId,
          pid: runner.lock.pid,
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
          sessionId: runner.lock.sessionId,
          pid: runner.lock.pid,
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
          sessionId: runner.lock.sessionId,
          pid: runner.lock.pid,
          heartbeatState: 'stale',
          heartbeatAgeMs: input.nowMs - runner.lifecycle.heartbeatAtMs,
        },
      });
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
            sessionId: runner.lock.sessionId,
            pid: runner.lock.pid,
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
        fileName: deadLetter.fileName,
        sessionIds: [...deadLetter.sessionIds],
        entryCount: deadLetter.entryCount,
      },
    });
  }

  if (input.serverRoles) {
    const roles = input.serverRoles;
    const driftKinds: ('role' | 'port')[] = [];
    const rolesSwapped = comparableUrl(roles.resolvedServerUrl) === comparableUrl(roles.profileWebappUrl)
      && comparableUrl(roles.resolvedWebappUrl) === comparableUrl(roles.profileServerUrl)
      && comparableUrl(roles.profileServerUrl) !== comparableUrl(roles.profileWebappUrl);
    if (rolesSwapped) driftKinds.push('role');

    const serverPortDrift = urlHost(roles.resolvedServerUrl) === urlHost(roles.profileServerUrl)
      && urlPort(roles.resolvedServerUrl) !== urlPort(roles.profileServerUrl);
    const webappPortDrift = urlHost(roles.resolvedWebappUrl) === urlHost(roles.profileWebappUrl)
      && urlPort(roles.resolvedWebappUrl) !== urlPort(roles.profileWebappUrl);
    if (serverPortDrift || webappPortDrift || rolesSwapped) driftKinds.push('port');

    if (driftKinds.length > 0) {
      findings.push({
        code: 'server_webapp_role_port_drift',
        severity: 'warning',
        data: {
          ...roles,
          driftKinds,
        },
      });
    }
  }

  return findings;
}
