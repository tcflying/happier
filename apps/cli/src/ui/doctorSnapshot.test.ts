import { describe, expect, it, vi } from 'vitest';

const { readCredentialsMock, readSettingsMock } = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(async () => null as { token: string } | null),
  readSettingsMock: vi.fn(async () => ({
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: 'cloud',
    servers: {
      cloud: {
        id: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://api.happier.dev?token=abc',
        publicServerUrl: 'https://api.happier.dev?token=abc',
        webappUrl: 'https://app.happier.dev?token=abc',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
    },
    lastChangesCursorByServerIdByAccountId: {
      cloud: {
        acct_old: 10,
      },
    },
  })),
}));

const { collectRunnerDoctorDiagnosticsMock } = vi.hoisted(() => ({
  collectRunnerDoctorDiagnosticsMock: vi.fn(async (_params?: unknown) => ([{
    code: 'session_mutation_dead_letter' as const,
    severity: 'warning' as const,
    data: {
      machineId: 'machine_local',
      fileName: 'session-s1.dead-letter.json',
      sessionIds: ['s1'],
      entryCount: 1,
      recoveryRecommendation: 'Inspect and preserve the dead-letter before replay.',
    },
  }])),
}));

const { readDaemonStatusSnapshotMock } = vi.hoisted(() => ({
  readDaemonStatusSnapshotMock: vi.fn(async () => ({
    server: {
      activeServerId: 'stack_main__id_default',
      serverUrl: 'http://127.0.0.1:3005',
      localServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://relay.happier.dev?token=abc',
      webappUrl: 'https://app.happier.dev?token=abc',
      comparableKey: 'https://relay.happier.dev',
    },
    daemon: {
      running: true,
      pid: 7777,
      httpPort: 3005,
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
  })),
}));

const {
  listInstalledVersionIdsNewestFirstMock,
  resolveInstalledFirstPartyComponentPathsMock,
} = vi.hoisted(() => ({
  listInstalledVersionIdsNewestFirstMock: vi.fn(async ({ channel }: { channel?: string }) =>
    channel === 'publicdev' ? ['0.2.5-dev.7.1'] : [],
  ),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn(({ channel }: { channel?: string }) => ({
    installRoot: channel === 'publicdev' ? '/Users/test/.happier/cli-dev' : `/Users/test/.happier/cli-${channel ?? 'stable'}`,
    currentPath: channel === 'publicdev' ? '/Users/test/.happier/cli-dev/current' : `/Users/test/.happier/cli-${channel ?? 'stable'}/current`,
    previousPath: channel === 'publicdev' ? '/Users/test/.happier/cli-dev/previous' : `/Users/test/.happier/cli-${channel ?? 'stable'}/previous`,
    versionsDir: channel === 'publicdev' ? '/Users/test/.happier/cli-dev/versions' : `/Users/test/.happier/cli-${channel ?? 'stable'}/versions`,
    binaryPath: channel === 'publicdev' ? '/Users/test/.happier/cli-dev/current/happier' : `/Users/test/.happier/cli-${channel ?? 'stable'}/current/happier`,
    nodeEntrypointPath: null,
    shimPaths: channel === 'publicdev' ? ['/Users/test/.local/bin/hdev'] : [`/Users/test/.local/bin/${channel === 'preview' ? 'hprev' : 'happier'}`],
  })),
}));

const {
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceInventoryEntriesMock,
} = vi.hoisted(() => ({
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn(() => ({
    platform: 'darwin',
    channel: 'publicdev',
    targetMode: 'default-following',
    instanceId: 'default',
    uid: 501,
    userHomeDir: '/Users/test',
    happierHomeDir: '/Users/test/.happier',
    serverUrl: 'https://api.happier.dev',
    publicServerUrl: 'https://relay.happier.dev',
    webappUrl: 'https://app.happier.dev',
    nodePath: '/usr/bin/node',
    entryPath: '/Users/test/.happier/cli-dev/current/happier',
  })),
  resolveDaemonServiceInventoryEntriesMock: vi.fn(async (_params?: unknown) => ([
    {
      serviceType: 'daemon',
      serverId: 'default',
      name: 'Default background service',
      path: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
      mode: 'user',
      label: 'com.happier.cli.daemon.default',
      ring: 'publicdev',
      targetMode: 'default-following',
      installed: true,
      platform: 'darwin',
      configuredCliVersion: '0.2.5-dev.7.1',
      runningCliVersion: '0.2.5-dev.7.1',
      running: true,
    },
  ])),
}));

const { resolveBackgroundServiceRepairPlanForCurrentRuntimeMock } = vi.hoisted(() => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock: vi.fn(async () => ({
    runtime: {
      platform: 'darwin',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      uid: 501,
      userHomeDir: '/Users/test',
      happierHomeDir: '/Users/test/.happier',
      serverUrl: 'https://api.happier.dev',
      publicServerUrl: 'https://relay.happier.dev',
      webappUrl: 'https://app.happier.dev',
      nodePath: '/usr/bin/node',
      entryPath: '/Users/test/.happier/cli-dev/current/happier',
    },
    services: [],
    scannedModes: ['user'],
    plan: {
      currentReleaseChannel: 'publicdev',
      existingServices: [],
      actions: [
        {
          kind: 'install-default-following-service',
          releaseChannel: 'publicdev',
          mode: 'user',
        },
      ],
      manualWarnings: ['Legacy background service cleanup is required first.'],
    },
  })),
}));

const { readRelayStatusMock } = vi.hoisted(() => ({
  readRelayStatusMock: vi.fn(async ({ channel, mode }: { channel?: string; mode?: string }) => {
    if (channel === 'preview' && mode === 'system') {
      return {
        installed: true,
        version: '0.2.4-preview.10',
        service: {
          active: false,
          enabled: true,
        },
        baseUrl: 'http://127.0.0.1:4410?token=abc',
        healthy: false,
        warnings: ['Preview relay requires manual cleanup at http://127.0.0.1:4410?token=abc'],
      };
    }
    if (channel === 'dev' && mode === 'user') {
      return {
        installed: true,
        version: '0.2.5-dev.7.1',
        service: {
          active: true,
          enabled: true,
        },
        baseUrl: 'http://127.0.0.1:4400?token=abc',
        healthy: true,
      };
    }
    return {
      installed: false,
      version: null,
      service: {
        active: null,
        enabled: null,
      },
      baseUrl: `http://127.0.0.1:${mode === 'system' ? '55' : '44'}${channel === 'preview' ? '10' : channel === 'dev' ? '00' : '20'}`,
      healthy: null,
    };
  }),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerId: 'stack_main__id_default',
    serverUrl: 'http://127.0.0.1:3005',
    publicServerUrl: 'http://127.0.0.1:3005',
    webappUrl: 'http://127.0.0.1:3005',
    publicReleaseRing: 'publicdev',
    currentCliVersion: '0.2.5-dev.7.1',
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
}));

vi.mock('@/daemon/statusSnapshot', () => ({
  readDaemonStatusSnapshot: () => readDaemonStatusSnapshotMock(),
}));

vi.mock('@/diagnostics/collectRunnerDoctorDiagnostics', () => ({
  collectRunnerDoctorDiagnostics: (params: unknown) => collectRunnerDoctorDiagnosticsMock(params),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    listInstalledVersionIdsNewestFirst: (params: { channel?: string }) => listInstalledVersionIdsNewestFirstMock(params),
    resolveInstalledFirstPartyComponentPaths: (params: { channel?: string }) => resolveInstalledFirstPartyComponentPathsMock(params),
  };
});

vi.mock('@/daemon/service/cli', () => {
  return {
    resolveDaemonServiceCliRuntimeFromEnv: () => resolveDaemonServiceCliRuntimeFromEnvMock(),
    resolveDaemonServiceInventoryEntries: (params: unknown) => resolveDaemonServiceInventoryEntriesMock(params),
  };
});

vi.mock('@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime', () => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntime: () => resolveBackgroundServiceRepairPlanForCurrentRuntimeMock(),
}));

vi.mock('@happier-dev/cli-common/relayHost', () => ({
  createRelayHostEngine: () => ({
    readStatus: (params: { channel?: string; mode?: string }) => readRelayStatusMock(params),
  }),
}));

import { buildDoctorSnapshot } from './doctorSnapshot';

describe('buildDoctorSnapshot', () => {
  it('includes active server, settings server profiles, and decoded account id', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'acct_123' })).toString('base64url');
    readCredentialsMock.mockResolvedValueOnce({ token: `header.${payload}.sig` });

    const snapshot = await buildDoctorSnapshot();

    expect(snapshot.server.activeServerId).toBe('stack_main__id_default');
    expect(snapshot.server.serverUrl).toBe('http://127.0.0.1:3005');
    expect(snapshot.settings.activeServerId).toBe('cloud');
    expect(snapshot.settings.servers.map((entry) => entry.id)).toContain('cloud');
    expect(snapshot.accountId).toBe('acct_123');
    expect(snapshot.daemonStatus?.auth.needsAuth).toBe(true);
    expect(snapshot.daemonStatus?.server.publicServerUrl).toBe('https://relay.happier.dev');
    expect(snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(snapshot.installations?.happier?.activeInvocation?.ring).toBe('dev');
    expect(snapshot.installations?.happier?.activeInvocation?.installationId).toBe('firstPartyManaged:dev');
    expect(snapshot.installations?.happier?.installations[0]?.managedRoot).toBe('/Users/test/.happier/cli-dev');
    expect(snapshot.services?.happier?.services[0]?.ring).toBe('dev');
    expect(snapshot.services?.happier?.services[0]?.configuredCliVersion).toBe('0.2.5-dev.7.1');
    expect(snapshot.services?.happier?.services[0]?.runningCliVersion).toBe('0.2.5-dev.7.1');
    expect(snapshot.relays?.happier?.relays).toEqual([
      {
        id: 'preview:system',
        ring: 'preview',
        scope: 'system',
        installed: true,
        version: '0.2.4-preview.10',
        relayUrl: 'http://127.0.0.1:4410',
        healthy: false,
        serviceActive: false,
        serviceEnabled: true,
        warnings: ['Preview relay requires manual cleanup at http://127.0.0.1:4410'],
      },
      {
        id: 'dev:user',
        ring: 'dev',
        scope: 'user',
        installed: true,
        version: '0.2.5-dev.7.1',
        relayUrl: 'http://127.0.0.1:4400',
        healthy: true,
        serviceActive: true,
        serviceEnabled: true,
      },
    ]);
    expect(snapshot.warnings?.map((warning) => warning.code)).toContain('backgroundServiceRepairRecommended');
    expect(snapshot.warnings?.map((warning) => warning.code)).toContain('backgroundServiceRepairManual');
    expect(snapshot.runtimeDiagnostics).toEqual([
      expect.objectContaining({
        code: 'session_mutation_dead_letter',
        data: expect.objectContaining({ sessionIds: ['s1'], entryCount: 1 }),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('?token=');
    expect(readRelayStatusMock).toHaveBeenCalledTimes(6);
  });
});
