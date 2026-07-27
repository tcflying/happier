import { describe, expect, it } from 'vitest';

import { buildRunnerDoctorDiagnostics } from './runnerDoctorDiagnostics';

const healthyLifecycle = {
  sessionId: 'session-healthy',
  pid: 123,
  generationId: 'generation-healthy',
  phase: 'running' as const,
  phaseStartedAtMs: 99_000,
  heartbeatAtMs: 99_900,
  cliVersion: '1.2.3',
  runnerBuildId: 'build-current',
};

describe('buildRunnerDoctorDiagnostics', () => {
  it('returns no findings for healthy runner, mutation, version, and URL fixtures', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: 'build-current',
      runners: [{
        sessionActive: true,
        processState: 'servable',
        lock: {
          sessionId: 'session-healthy',
          pid: 123,
          acquiredAtMs: 99_000,
          generationId: 'generation-healthy',
          processCommandHash: 'a'.repeat(64),
        },
        lifecycle: healthyLifecycle,
      }],
      mutationDeadLetters: [],
      serverRoles: {
        serverId: 'cloud',
        resolvedServerUrl: 'https://api.happier.dev',
        resolvedWebappUrl: 'https://app.happier.dev',
        profileServerUrl: 'https://api.happier.dev',
        profileWebappUrl: 'https://app.happier.dev',
      },
    });

    expect(findings).toEqual([]);
  });

  it('reports all six typed diagnostic categories without depending on prose', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: 'build-current',
      runners: [{
        sessionActive: false,
        processState: 'servable',
        lock: {
          sessionId: 'session-stale',
          pid: 999,
          acquiredAtMs: 1,
          generationId: 'generation-stale',
          processCommandHash: 'a'.repeat(64),
        },
        lifecycle: {
          sessionId: 'session-stale',
          pid: 999,
          generationId: 'generation-stale',
          phase: 'cleanup',
          phaseStartedAtMs: 50_000,
          heartbeatAtMs: 60_000,
          cleanupDeadlineAtMs: 70_000,
          cliVersion: '1.0.0',
          runnerBuildId: 'build-old',
        },
      }],
      mutationDeadLetters: [{
        fileName: 'session-session-stale.dead-letter.json',
        sessionIds: ['session-stale'],
        entryCount: 2,
      }],
      serverRoles: {
        serverId: 'local',
        resolvedServerUrl: 'http://127.0.0.1:5173',
        resolvedWebappUrl: 'http://127.0.0.1:3005',
        profileServerUrl: 'http://127.0.0.1:3005',
        profileWebappUrl: 'http://127.0.0.1:5173',
      },
    });

    expect(new Set(findings.map((finding) => finding.code))).toEqual(new Set([
      'inactive_session_runner_lock',
      'runner_cleanup_overdue',
      'runner_heartbeat_stale',
      'session_mutation_dead_letter',
      'runner_cli_build_drift',
      'server_webapp_role_port_drift',
    ]));
    expect(findings.find((finding) => finding.code === 'runner_cleanup_overdue')?.data).toEqual(
      expect.objectContaining({ sessionId: 'session-stale', deadlineAtMs: 70_000 }),
    );
    expect(findings.find((finding) => finding.code === 'session_mutation_dead_letter')?.data).toEqual(
      expect.objectContaining({ entryCount: 2, sessionIds: ['session-stale'] }),
    );
    expect(JSON.stringify(findings)).not.toContain('token');
  });

  it('reports a missing authoritative heartbeat while preserving unknown process identity', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: null,
      runners: [{
        sessionActive: false,
        processState: 'servable',
        lock: {
          sessionId: 'session-missing-heartbeat',
          pid: 999,
          acquiredAtMs: 1,
          generationId: 'generation-missing-heartbeat',
          processCommandHash: 'a'.repeat(64),
        },
        lifecycle: null,
      }],
      mutationDeadLetters: [],
      serverRoles: null,
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runner_heartbeat_stale',
        data: expect.objectContaining({ heartbeatState: 'missing' }),
      }),
      expect.objectContaining({
        code: 'inactive_session_runner_lock',
        data: expect.objectContaining({ lockState: 'unknown' }),
      }),
    ]));
  });

  it('reports a stalled runner log with complete recovery context', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: 'build-current',
      machineId: 'machine-local',
      runners: [{
        sessionActive: false,
        processState: 'servable',
        lock: {
          sessionId: 'session-log-stale',
          pid: 456,
          acquiredAtMs: 10_000,
          generationId: 'generation-log-stale',
          processCommandHash: 'a'.repeat(64),
        },
        lifecycle: {
          sessionId: 'session-log-stale',
          pid: 456,
          generationId: 'generation-log-stale',
          phase: 'cleanup',
          phaseStartedAtMs: 60_000,
          heartbeatAtMs: 65_000,
          cleanupDeadlineAtMs: 120_000,
          cliVersion: '1.2.3',
          runnerBuildId: 'build-current',
        },
        log: {
          fileName: '2026-07-27-04-00-00-pid-456.log',
          lastWriteAtMs: 60_000,
        },
      }],
      mutationDeadLetters: [],
      serverRoles: null,
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'runner_log_stale',
      severity: 'warning',
      data: expect.objectContaining({
        machineId: 'machine-local',
        sessionId: 'session-log-stale',
        pid: 456,
        generationId: 'generation-log-stale',
        lastHeartbeatAtMs: 65_000,
        cleanupPhase: 'cleanup',
        logState: 'stale',
        lastLogWriteAtMs: 60_000,
        recoveryRecommendation: expect.any(String),
      }),
    }));
  });

  it('does not infer port drift from a pure server/webapp role swap', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: null,
      runners: [],
      mutationDeadLetters: [],
      serverRoles: {
        serverId: 'local',
        resolvedServerUrl: 'http://127.0.0.1:5173',
        resolvedWebappUrl: 'http://127.0.0.1:3005',
        profileServerUrl: 'http://127.0.0.1:3005',
        profileWebappUrl: 'http://127.0.0.1:5173',
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'server_webapp_role_port_drift',
        data: expect.objectContaining({ driftKinds: ['role'] }),
      }),
    ]);
  });

  it('blocks a loopback profile whose web app points at the relay endpoint', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: null,
      runners: [],
      mutationDeadLetters: [],
      serverRoles: {
        serverId: 'local',
        resolvedServerUrl: 'http://127.0.0.1:52211',
        resolvedWebappUrl: 'http://localhost:52211',
        profileServerUrl: 'http://127.0.0.1:52211',
        profileWebappUrl: 'http://localhost:52211',
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'server_webapp_role_port_drift',
        severity: 'error',
        data: expect.objectContaining({
          driftKinds: ['same_endpoint'],
          recoveryRecommendation: expect.any(String),
        }),
      }),
    ]);
  });

  it('blocks a web app URL that aliases the profile local relay URL', () => {
    const findings = buildRunnerDoctorDiagnostics({
      nowMs: 100_000,
      heartbeatTimeoutMs: 30_000,
      currentCliVersion: '1.2.3',
      currentRunnerBuildId: null,
      runners: [],
      mutationDeadLetters: [],
      serverRoles: {
        serverId: 'local-stack',
        resolvedServerUrl: 'http://127.0.0.1:52211',
        resolvedWebappUrl: 'http://localhost:52211',
        profileServerUrl: 'https://relay.example.test',
        profileLocalServerUrl: 'http://127.0.0.1:52211',
        profileWebappUrl: 'http://localhost:52211',
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'server_webapp_role_port_drift',
        severity: 'error',
        data: expect.objectContaining({
          profileLocalServerUrl: 'http://127.0.0.1:52211',
          driftKinds: ['same_endpoint'],
        }),
      }),
    ]);
  });
});
