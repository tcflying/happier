import { resolve } from 'node:path'

import type { UserConfig } from 'vitest/config'

export function resolveFocusedTestRunRoot(env: NodeJS.ProcessEnv): string {
  const configuredRunRoot = env.HAPPIER_CLI_FOCUSED_TEST_RUN_DIR?.trim()
  if (!configuredRunRoot) {
    throw new Error(
      'HAPPIER_CLI_FOCUSED_TEST_RUN_DIR is required; run focused tests through `yarn test:focused <test-file>`.',
    )
  }
  return resolve(configuredRunRoot)
}

export function createFocusedVitestConfig(unitConfig: UserConfig, runRoot: string): UserConfig {
  return {
    ...unitConfig,
    cacheDir: resolve(runRoot, 'vite-cache'),
    test: {
      ...unitConfig.test,
      globalSetup: ['./src/test-setup.focused.ts'],
      coverage: {
        ...unitConfig.test?.coverage,
        reportsDirectory: resolve(runRoot, 'coverage'),
      },
    },
  }
}
