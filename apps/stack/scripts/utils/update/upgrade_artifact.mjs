import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let atomicWriteSequence = 0;

function assertOperationId(value) {
  const operationId = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) {
    throw new Error('Upgrade operation id must contain only letters, numbers, dot, underscore, or dash');
  }
  return operationId;
}

async function writeJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${atomicWriteSequence}.tmp`;
  atomicWriteSequence += 1;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export function createUpgradeArtifactWriter({
  homeDir,
  operationId,
  now = () => new Date().toISOString(),
}) {
  const safeOperationId = assertOperationId(operationId);
  const artifactDir = join(homeDir, 'artifacts', 'upgrades');
  const inProgressPath = join(artifactDir, `${safeOperationId}.in-progress.json`);
  const finalPath = join(artifactDir, `${safeOperationId}.json`);
  let startedArtifact = null;

  return {
    inProgressPath,
    finalPath,
    async start(input) {
      await mkdir(artifactDir, { recursive: true });
      startedArtifact = {
        contractVersion: 1,
        operationId: safeOperationId,
        operation: 'hstack_self_update',
        status: 'running',
        terminal: false,
        startedAt: now(),
        finishedAt: null,
        exitCode: null,
        failureStage: null,
        retryCount: 0,
        attempts: [],
        packageName: input.packageName,
        requestedSpec: input.requestedSpec,
        packageVersions: {
          before: input.packageVersionBefore ?? null,
          after: null,
        },
        lockSha256: input.lockSha256 ?? 'unavailable',
        serviceHealth: {
          state: 'not_checked',
          checkedAt: null,
        },
      };
      await writeJson(inProgressPath, startedArtifact);
      return inProgressPath;
    },
    async finish(input) {
      if (!startedArtifact) {
        throw new Error('Upgrade artifact must be started before it can finish');
      }
      const attempts = Array.isArray(input.attempts) ? input.attempts : [];
      const terminalArtifact = {
        ...startedArtifact,
        ...input,
        terminal: true,
        finishedAt: now(),
        retryCount: Math.max(0, attempts.length - 1),
        attempts,
      };
      await writeJson(finalPath, terminalArtifact);
      await unlink(inProgressPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return finalPath;
    },
  };
}
