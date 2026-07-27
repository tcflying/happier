import { describe, expect, it } from 'vitest';

import {
  challengeSessionRunnerControl,
  startSessionRunnerControlChallengeServer,
} from './sessionRunnerControlChallenge';

describe('session runner control challenge', () => {
  it('proves the exact live session generation by echoing a fresh nonce', async () => {
    const server = await startSessionRunnerControlChallengeServer({
      sessionId: 'sess-control',
      generationId: 'generation-control-1',
    });

    try {
      await expect(challengeSessionRunnerControl({
        sessionId: 'sess-control',
        generationId: 'generation-control-1',
        controlPort: server.port,
        nonce: 'nonce-control-1234',
      })).resolves.toBe(true);

      await expect(challengeSessionRunnerControl({
        sessionId: 'sess-control',
        generationId: 'generation-control-2',
        controlPort: server.port,
        nonce: 'nonce-control-5678',
      })).resolves.toBe(false);
    } finally {
      await server.close();
    }
  });

  it('fails closed when the generation endpoint is no longer serving', async () => {
    const server = await startSessionRunnerControlChallengeServer({
      sessionId: 'sess-control-closed',
      generationId: 'generation-control-closed',
    });
    await server.close();

    await expect(challengeSessionRunnerControl({
      sessionId: 'sess-control-closed',
      generationId: 'generation-control-closed',
      controlPort: server.port,
      nonce: 'nonce-control-closed',
      timeoutMs: 50,
    })).resolves.toBe(false);
  });
});
