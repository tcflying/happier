import { describe, expect, it } from 'vitest';

import { DoctorSnapshotSchema, parseDoctorSnapshotSafe } from './doctorSnapshot.js';

describe('DoctorSnapshotSchema', () => {
  it('accepts a valid snapshot and parseDoctorSnapshotSafe redacts userinfo/query/hash', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
        publicServerUrl: 'https://api.happier.dev/path?token=abc',
        webappUrl: 'https://app.happier.dev/?token=abc',
      },
      accountId: 'acct_123',
      settings: {
        activeServerId: 'cloud',
        servers: [
          {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
            webappUrl: 'https://app.happier.dev/?token=abc',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        ],
        knownAccountIds: ['acct_123'],
      },
      installations: {
        happier: {
          activeInvocation: {
            path: '/Users/test/.local/bin/hdev',
            realPath: '/Users/test/.happier/cli-dev/current/happier',
            invokerName: 'hdev',
            ring: 'dev',
            version: '0.2.5-dev.7.1',
            installationId: 'firstPartyManaged:dev',
          },
          installations: [
            {
              id: 'firstPartyManaged:dev',
              source: 'firstPartyManaged',
              components: ['happier-cli'],
              ring: 'dev',
              version: '0.2.5-dev.7.1',
              path: '/Users/test/.happier/cli-dev/current/happier?token=abc',
              realPath: '/Users/test/.happier/cli-dev/versions/0.2.5-dev.7.1/happier?token=abc',
              shimName: 'hdev',
              onPath: true,
              managedRoot: '/Users/test/.happier/cli-dev',
            },
          ],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'svc-default',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.cli.daemon.default',
              verification: 'verified',
              targetMode: 'default-following',
              ring: 'dev',
              instanceId: 'default',
              scope: 'user',
              definitionPath: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
              executablePath: null,
              serverUrl: 'https://api.happier.dev/path?token=abc',
              publicServerUrl: 'https://relay.happier.dev/path?token=abc',
              installed: true,
              running: true,
              configuredCliVersion: '0.2.5-dev.7.1',
              runningCliVersion: '0.2.5-dev.7.1',
            },
          ],
        },
      },
      relays: {
        happier: {
          relays: [
            {
              id: 'dev:user',
              ring: 'dev',
              scope: 'user',
              installed: true,
              version: '0.2.5-dev.7.1',
              relayUrl: 'http://127.0.0.1:4400/?token=abc#frag',
              healthy: true,
              serviceActive: true,
              serviceEnabled: true,
              warnings: ['Legacy relay install detected at http://127.0.0.1:4400/?token=abc'],
            },
          ],
        },
      },
      warnings: [
        {
          code: 'backgroundServiceRepairRecommended',
          severity: 'warning',
          message: 'Background service repair is recommended.',
          repairCommands: ['happier doctor repair --yes'],
        },
      ],
      runtimeDiagnostics: [
        {
          code: 'runner_cleanup_overdue',
          severity: 'warning',
          data: {
            machineId: 'machine_123',
            sessionId: 'session_stale',
            pid: 9001,
            generationId: 'generation_stale',
            processState: 'zombie',
            lastHeartbeatAtMs: 1_765_000_000_000,
            cleanupPhase: 'cleanup',
            recoveryRecommendation: 'Restart the daemon and resume the session.',
            deadlineAtMs: 1_765_000_030_000,
            overdueByMs: 45_000,
          },
        },
        {
          code: 'server_webapp_role_port_drift',
          severity: 'error',
          data: {
            serverId: 'local',
            resolvedServerUrl: 'http://127.0.0.1:52211/?token=abc',
            resolvedWebappUrl: 'http://localhost:52211/?token=abc',
            profileServerUrl: 'https://relay.example.test/?token=abc',
            profileLocalServerUrl: 'http://127.0.0.1:52211/?token=abc',
            profileWebappUrl: 'http://localhost:52211/?token=abc',
            driftKinds: ['same_endpoint'],
            recoveryRecommendation: 'Set distinct relay and web app URLs.',
          },
        },
      ],
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
          localServerUrl: 'http://127.0.0.1:3005/?token=abc',
          publicServerUrl: 'https://api.happier.dev/path?token=abc',
          webappUrl: 'https://app.happier.dev/?token=abc',
          comparableKey: 'https://api.happier.dev',
        },
        daemon: {
          running: true,
          pid: 4321,
          httpPort: null,
          startedWithCliVersion: '1.2.3',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'background-service',
          serviceManaged: true,
          serviceLabel: 'com.happier.cli.daemon.default',
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: false,
          machineId: null,
          needsAuth: true,
          accountId: 'acct_123',
        },
      },
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(DoctorSnapshotSchema.safeParse(parsed.snapshot).success).toBe(true);
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain('admin:secret');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('#frag');
    expect(parsed.snapshot.daemonStatus?.server.localServerUrl).toBe('http://127.0.0.1:3005');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(parsed.snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(parsed.snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(parsed.snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(parsed.snapshot.installations?.happier?.activeInvocation?.ring).toBe('dev');
    expect(parsed.snapshot.services?.happier?.services[0]?.publicServerUrl).toBe('https://relay.happier.dev/path');
    expect(parsed.snapshot.services?.happier?.services[0]?.configuredCliVersion).toBe('0.2.5-dev.7.1');
    expect(parsed.snapshot.relays?.happier?.relays[0]?.relayUrl).toBe('http://127.0.0.1:4400');
    expect(parsed.snapshot.relays?.happier?.relays[0]?.warnings).toEqual(['Legacy relay install detected at http://127.0.0.1:4400']);
    expect(parsed.snapshot.warnings?.[0]?.repairCommands).toEqual(['happier doctor repair --yes']);
    expect(parsed.snapshot.runtimeDiagnostics?.[0]).toEqual(expect.objectContaining({
      code: 'runner_cleanup_overdue',
      data: expect.objectContaining({
        machineId: 'machine_123',
        sessionId: 'session_stale',
        generationId: 'generation_stale',
        cleanupPhase: 'cleanup',
      }),
    }));
    expect(parsed.snapshot.runtimeDiagnostics?.[1]).toEqual(expect.objectContaining({
      code: 'server_webapp_role_port_drift',
      severity: 'error',
      data: expect.objectContaining({
        profileLocalServerUrl: 'http://127.0.0.1:52211',
        driftKinds: ['same_endpoint'],
      }),
    }));
  });

  it('returns a stable error for invalid JSON', () => {
    const parsed = parseDoctorSnapshotSafe('{not json}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected error');
    expect(parsed.error).toMatch(/invalid json/i);
  });
});
