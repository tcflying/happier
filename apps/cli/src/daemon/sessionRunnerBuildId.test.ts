import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionRunnerBuildId } from './sessionRunnerBuildId';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveSessionRunnerBuildId', () => {
  it('returns a stable content hash for the runner entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runner-build-'));
    tempDirs.push(dir);
    const entryPath = join(dir, 'runner.js');
    await writeFile(entryPath, 'console.log("runner");\n', 'utf8');

    const first = await resolveSessionRunnerBuildId({ entryPath });
    const second = await resolveSessionRunnerBuildId({ entryPath });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('returns null when there is no readable entrypoint', async () => {
    await expect(resolveSessionRunnerBuildId({ entryPath: '' })).resolves.toBeNull();
    await expect(resolveSessionRunnerBuildId({ entryPath: 'Z:\\missing\\runner.js' })).resolves.toBeNull();
  });
});
