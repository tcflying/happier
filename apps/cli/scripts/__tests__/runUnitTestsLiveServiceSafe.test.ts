import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureDirectoryFingerprint,
  executeWithDirectoryMutationGuard,
} from '../runUnitTestsLiveServiceSafe.mjs';

describe('runUnitTestsLiveServiceSafe', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects any write to the guarded cli-common dist tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-live-dist-guard-'));
    temporaryRoots.push(root);
    const dist = join(root, 'packages', 'cli-common', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'before\n', 'utf8');
    const before = captureDirectoryFingerprint(dist);

    const result = executeWithDirectoryMutationGuard({
      guardedDirectory: dist,
      run: () => {
        writeFileSync(join(dist, 'index.js'), 'after\n', 'utf8');
        return 0;
      },
    });

    expect(result).toEqual({
      status: 0,
      before,
      after: expect.any(String),
      mutated: true,
    });
    expect(result.after).not.toBe(before);
  });

  it('accepts a read-only unit-test run', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-live-dist-readonly-'));
    temporaryRoots.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'stable\n', 'utf8');

    expect(executeWithDirectoryMutationGuard({
      guardedDirectory: dist,
      run: () => 0,
    })).toMatchObject({
      status: 0,
      mutated: false,
    });
  });
});
