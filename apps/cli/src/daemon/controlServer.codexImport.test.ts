import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

function createApp(overrides: Record<string, unknown> = {}) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine_local',
    stopSession: async () => false,
    spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'test-token',
    ...overrides,
  });
}

describe('daemon control server: /codex/direct-session-link', () => {
  it('requires the daemon control token', async () => {
    const handler = vi.fn();
    const app = createApp({ handleCodexDirectSessionLinkEnsure: handler });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/codex/direct-session-link',
        payload: { remoteSessionId: '019f8bc5-d747-7250-aedc-b3a2ddd3cffe', title: '桥接测试' },
      });

      expect(response.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('validates and forwards the Codex thread identity and title', async () => {
    const handler = vi.fn(async () => ({ ok: true, sessionId: 'happy-codex-1', created: true }));
    const app = createApp({ handleCodexDirectSessionLinkEnsure: handler });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/codex/direct-session-link',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          remoteSessionId: '019f8bc5-d747-7250-aedc-b3a2ddd3cffe',
          title: '桥接测试',
          directory: 'D:\\codex-project\\fusion-happier',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, sessionId: 'happy-codex-1', created: true });
      expect(handler).toHaveBeenCalledWith({
        remoteSessionId: '019f8bc5-d747-7250-aedc-b3a2ddd3cffe',
        title: '桥接测试',
        directory: 'D:\\codex-project\\fusion-happier',
      });
    } finally {
      await app.close();
    }
  });

  it('returns 501 when the daemon does not provide the bridge handler', async () => {
    const app = createApp();

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/codex/direct-session-link',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { remoteSessionId: 'thread-1', title: '桥接测试' },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ ok: false, errorCode: 'codex_direct_session_link_handler_unavailable' });
    } finally {
      await app.close();
    }
  });
});
