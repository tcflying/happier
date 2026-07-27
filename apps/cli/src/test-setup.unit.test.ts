import { describe, expect, it, vi } from 'vitest';

const setup = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./test-setup', () => ({ setup }));

import globalSetup from './test-setup.unit';

describe('CLI unit global setup', () => {
  it('validates existing shared artifacts without rebuilding live dist', async () => {
    await globalSetup();

    expect(setup).toHaveBeenCalledWith({ buildMode: 'existing-only' });
  });
});
