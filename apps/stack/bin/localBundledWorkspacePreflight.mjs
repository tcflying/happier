import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBundledWorkspaceSyncModulePath } from '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs';
import { coerceHappyMonorepoRootFromPath } from '../scripts/utils/paths/paths.mjs';
import { withWorkspaceBundleLock } from '../scripts/utils/workspaces/workspaceBundleLock.mjs';

function resolveWorkspaceBundleLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
}

export async function refreshLocalBundledWorkspacePackages(cliRootDir) {
  const cliRoot = String(cliRootDir ?? '').trim();
  if (!cliRoot) return;
  const disabled = String(process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES ?? '').trim().toLowerCase();
  if (disabled === '0' || disabled === 'false' || disabled === 'no') return;

  const repoRoot = coerceHappyMonorepoRootFromPath(cliRoot);
  if (!repoRoot) return;
  const syncModulePath = resolveBundledWorkspaceSyncModulePath(cliRoot);
  if (syncModulePath) {
    await withWorkspaceBundleLock(async () => {
      const { syncBundledWorkspacePackages } = await import(pathToFileURL(syncModulePath).href);
      syncBundledWorkspacePackages({
        repoRoot,
        hostApps: ['stack'],
        replaceExisting: false,
      });
    }, {
      lockPath: resolveWorkspaceBundleLockPath(repoRoot),
      timeoutMs: 240_000,
      pollIntervalMs: 250,
      staleAfterMs: 240_000,
    });
  }

  const { bundleWorkspaceDeps } = await import('../scripts/bundleWorkspaceDeps.mjs');
  await bundleWorkspaceDeps({
    repoRoot,
    stackDir: cliRoot,
  });
}
