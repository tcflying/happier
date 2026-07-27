import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const { renameMock, renameDelegate } = vi.hoisted(() => ({
  renameMock: vi.fn(),
  renameDelegate: { current: null },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  renameDelegate.current = actual.rename;
  return {
    ...actual,
    rename: renameMock,
  };
});

describe('cli-common build Windows rename fallback', () => {
  const tempDirs = [];

  afterEach(() => {
    renameMock.mockReset();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries transient Windows rename errors within a bounded delay budget', async () => {
    const { renameWithControlledRetry } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const renameImpl = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: transient scanner lock'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: transient scanner lock'), { code: 'EBUSY' }))
      .mockResolvedValue(undefined);
    const observedDelays = [];

    await renameWithControlledRetry('from-dir', 'to-dir', {
      renameImpl,
      delayImpl: async (delayMs) => {
        observedDelays.push(delayMs);
      },
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 20,
    });

    expect(renameImpl).toHaveBeenCalledTimes(3);
    expect(observedDelays).toEqual([10, 20]);
  });

  it('leaves the live dist intact when its rename stays locked', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-locked-'));
    tempDirs.push(fixtureDir);
    const buildId = 'locked-dist';
    const distDir = join(fixtureDir, 'dist');
    const backupDir = join(fixtureDir, `.dist.backup.${buildId}`);

    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const liveValue = true;\n', 'utf8');
    writeFileSync(join(distDir, 'index.d.ts'), 'export declare const liveValue: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-locked-fixture',
      exports: {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
    }, null, 2), 'utf8');

    renameMock.mockImplementation(async (from, to) => {
      if (from === distDir && to === backupDir) {
        throw Object.assign(new Error('EPERM: live service holds dist'), { code: 'EPERM' });
      }
      return renameDelegate.current(from, to);
    });

    await expect(buildCliCommonDist({
      packageDir: fixtureDir,
      buildId,
      lockPath: join(fixtureDir, 'build.lock'),
      renameRetryOptions: {
        maxAttempts: 3,
        initialDelayMs: 0,
        delayImpl: async () => {},
      },
      runCommandImpl: (_cmd, args) => {
        const tsconfigPath = join(fixtureDir, `.tsconfig.build.${buildId}.json`);
        const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
        const outDir = tsconfig.compilerOptions.outDir;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const stagedValue = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const stagedValue: boolean;\n', 'utf8');
        return { status: 0 };
      },
    })).rejects.toMatchObject({ code: 'EPERM' });

    expect(renameMock).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('liveValue');
  });

  it('copies staged dist into place when Windows blocks rename with EPERM', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-win32-'));
    tempDirs.push(fixtureDir);
    const buildId = 'rename-fallback';

    const distDir = join(fixtureDir, 'dist');
    const tempDistDir = join(fixtureDir, `.dist.build.${buildId}`);

    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const oldValue = true;\n', 'utf8');
    writeFileSync(join(distDir, 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
    }, null, 2), 'utf8');

    if (!renameDelegate.current) {
      throw new Error('expected node:fs/promises.rename delegate to initialize');
    }

    renameMock.mockImplementation(async (from, to) => {
      if (from === tempDistDir && to === distDir) {
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = 'EPERM';
        throw error;
      }
      return renameDelegate.current(from, to);
    });

    await buildCliCommonDist({
      packageDir: fixtureDir,
      buildId,
      lockPath: join(fixtureDir, 'build.lock'),
      renameRetryOptions: { maxAttempts: 1 },
      runCommandImpl: (_cmd, args) => {
        const tsconfigPath = join(fixtureDir, `.tsconfig.build.${buildId}.json`);
        const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
        const outDir = tsconfig.compilerOptions.outDir;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const newValue = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const newValue: boolean;\n', 'utf8');
        return { status: 0 };
      },
    });

    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('newValue');
  });
});
