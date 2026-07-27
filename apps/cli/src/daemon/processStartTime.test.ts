import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { readProcessStartTimeMs } from './processStartTime';

describe('readProcessStartTimeMs', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed without spawning for an invalid pid (%s)',
    (pid) => {
      expect(readProcessStartTimeMs(pid, 'win32')).toBeNull();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the process identity lookup times out', () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: '',
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    });

    expect(readProcessStartTimeMs(123, 'win32')).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ timeout: 2_000, shell: false, windowsHide: true }),
    );
  });
});
