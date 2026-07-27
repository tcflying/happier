import { defineConfig } from 'vitest/config'

import unitConfig from './vitest.config'
import { createFocusedVitestConfig, resolveFocusedTestRunRoot } from './vitest.focused.config.shared'

const runRoot = resolveFocusedTestRunRoot(process.env)

export default defineConfig(createFocusedVitestConfig(unitConfig, runRoot))
