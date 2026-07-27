import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /migrate-sessions', () => {
  it('runs old-runner migration only through the authenticated opt-in endpoint', async () => {
    const handleMigrateOldSessionRunners = vi.fn(async () => ({
      inspected: 2,
      migrationRequested: 1,
      migrationFailed: 0,
      current: 1,
      skipped: 0,
      sessions: [
        { sessionId: 'sess-current', pid: 101, status: 'current' as const },
        {
          sessionId: 'sess-old',
          pid: 102,
          status: 'migration_requested' as const,
          reason: 'cli_version_drift' as const,
        },
      ],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleMigrateOldSessionRunners,
    });

    try {
      await app.ready();
      const unauthorized = await app.inject({
        method: 'POST',
        url: '/migrate-sessions',
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(handleMigrateOldSessionRunners).not.toHaveBeenCalled();

      const response = await app.inject({
        method: 'POST',
        url: '/migrate-sessions',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(await handleMigrateOldSessionRunners.mock.results[0]!.value);
      expect(handleMigrateOldSessionRunners).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
