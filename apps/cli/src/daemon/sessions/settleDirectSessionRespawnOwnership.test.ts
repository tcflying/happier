import { describe, expect, it, vi } from 'vitest';

import { settleDirectSessionRespawnOwnership } from './settleDirectSessionRespawnOwnership';

describe('settleDirectSessionRespawnOwnership', () => {
  it('retains the ownership fence when a replacement is already running', async () => {
    const apiMachine = {
      claimDirectSessionRuntimeOwnership: vi.fn(async () => {}),
      releaseDirectSessionRuntimeOwnership: vi.fn(async () => {}),
    };

    await expect(settleDirectSessionRespawnOwnership({
      apiMachine: apiMachine as any,
      sessionId: 'sess-already-running',
      reason: 'already_running',
    })).resolves.toBe('claimed');

    expect(apiMachine.claimDirectSessionRuntimeOwnership).toHaveBeenCalledWith('sess-already-running');
    expect(apiMachine.releaseDirectSessionRuntimeOwnership).not.toHaveBeenCalled();
  });

  it('releases the fence when respawn is terminally cancelled', async () => {
    const apiMachine = {
      claimDirectSessionRuntimeOwnership: vi.fn(async () => {}),
      releaseDirectSessionRuntimeOwnership: vi.fn(async () => {}),
    };

    await expect(settleDirectSessionRespawnOwnership({
      apiMachine: apiMachine as any,
      sessionId: 'sess-stopped-during-backoff',
      reason: 'stop_requested',
    })).resolves.toBe('released');

    expect(apiMachine.releaseDirectSessionRuntimeOwnership).toHaveBeenCalledWith('sess-stopped-during-backoff');
    expect(apiMachine.claimDirectSessionRuntimeOwnership).not.toHaveBeenCalled();
  });
});
