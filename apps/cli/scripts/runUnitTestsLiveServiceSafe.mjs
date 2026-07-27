import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';

function appendDirectoryTreeHash(hash, root, current) {
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${relativePath}:${readlinkSync(absolutePath)}\n`, 'utf8');
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`dir:${relativePath}\n`, 'utf8');
      appendDirectoryTreeHash(hash, root, absolutePath);
      continue;
    }
    if (stat.isFile()) {
      hash.update(`file:${relativePath}:${stat.size}\n`, 'utf8');
      hash.update(readFileSync(absolutePath));
      continue;
    }
    hash.update(`other:${relativePath}:${stat.mode}\n`, 'utf8');
  }
}

export function captureDirectoryFingerprint(directory) {
  const normalized = resolve(directory);
  if (!existsSync(normalized)) return 'missing';
  const hash = createHash('sha256');
  hash.update(`root:${normalized}\n`, 'utf8');
  appendDirectoryTreeHash(hash, normalized, normalized);
  return hash.digest('hex');
}

export function executeWithDirectoryMutationGuard({ guardedDirectory, run }) {
  const before = captureDirectoryFingerprint(guardedDirectory);
  let status = 1;
  let error;
  try {
    status = run();
  } catch (caught) {
    error = caught;
  }
  const after = captureDirectoryFingerprint(guardedDirectory);
  return {
    status,
    before,
    after,
    mutated: before !== after,
    ...(error === undefined ? {} : { error }),
  };
}

export function runUnitTestsLiveServiceSafe() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptsDir, '..');
  const repoRoot = resolve(cliRoot, '..', '..');
  const guardedDirectory = join(repoRoot, 'packages', 'cli-common', 'dist');
  const invocation = resolveYarnCommandInvocation(['run', '-s', 'test:unit:run']);
  const result = executeWithDirectoryMutationGuard({
    guardedDirectory,
    run: () => {
      const child = spawnSync(invocation.command, invocation.args, {
        cwd: cliRoot,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments
          ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
          : {}),
      });
      if (child.error) throw child.error;
      return child.status ?? 1;
    },
  });

  if (result.mutated) {
    throw new Error(
      `CLI unit tests modified the live shared output at ${guardedDirectory} `
      + `(before=${result.before}, after=${result.after}).`,
    );
  }
  if (result.error) throw result.error;
  return result.status;
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  try {
    process.exitCode = runUnitTestsLiveServiceSafe();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
