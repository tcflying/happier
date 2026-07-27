import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import baseConfig from './vitest.config';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { vitestMjsShebangPlugin } from '../../scripts/testing/vitestMjsShebangPlugin';

const base = baseConfig as any;

/**
 * Harnesses that must run against Legend's NATIVE build.
 *
 * `@legendapp/list/react-native` publishes conditional exports whose `react-native` condition is
 * only selected by Metro. Under Node/Vite resolution the subpath falls through to
 * `./react-native.web.mjs`, so anything importing the package specifier here silently mounts the
 * DOM implementation. Selecting the build is a whole-run resolution decision - one Vite server
 * cannot hand the web harnesses the web artifact and the native harnesses the native one - so this
 * config disowns the native glob and `vitest.legend-native.config.ts` owns it instead.
 */
export const NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB = 'sources/**/*.native.real.integration.test.{ts,tsx}';

/**
 * Harnesses that must run the SHIPPED native path: the native build AND `Platform.OS === 'ios'`
 * AND New Architecture ON. Owned by `vitest.legend-fabric.config.ts`.
 *
 * Declared here, next to the glob it deliberately overlaps, because both lane configs need it and
 * importing it across them would make the two configs cyclic. Note the overlap is intentional: this
 * pattern also matches `NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB`, so the exclusion already written
 * below keeps these files out of the web-resolving run, and the native lane excludes them too.
 */
export const SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB = 'sources/**/*.fabric.native.real.integration.test.{ts,tsx}';

export default defineConfig({
    define: base.define,
    optimizeDeps: base.optimizeDeps,
    test: {
        ...(base.test ?? {}),
        // Integration tests are relatively few but heavy. Running them in a single thread is
        // more stable than the default multi-process fork pool under long-running SCM tests.
        pool: 'threads',
        poolOptions: {
            ...(base.test?.poolOptions ?? {}),
            threads: {
                ...(base.test?.poolOptions?.threads ?? {}),
                singleThread: true,
            },
        },
        server: {
            ...(base.test?.server ?? {}),
            deps: {
                ...(base.test?.server?.deps ?? {}),
                inline: [
                    ...(base.test?.server?.deps?.inline ?? []),
                    // `isolate: true` only resets modules Vitest itself loaded. An externalized
                    // dependency is loaded by Node and stays cached for the lifetime of the
                    // worker, which this pool reuses across every file - so the package keeps its
                    // module-level state from one test file to the next. `@legendapp/list` has
                    // several such singletons; the load-bearing one is `globalResizeObserver`
                    // (`createResizeObserver`), built once from whatever `ResizeObserver` global
                    // exists when the first list mounts and never rebuilt. The first real-Legend
                    // integration file to mount therefore donates its jsdom stub - and the
                    // file-local record registry that stub writes into - to every later file,
                    // whose own stub is never constructed and whose flush silently delivers
                    // nothing. Inlining restores per-file module state for the package so each
                    // harness measures through the observer it actually installed.
                    /@legendapp\/list/,
                ],
            },
        },
        include: [
            'sources/**/*.integration.test.{ts,tsx}',
            'sources/**/*.real.integration.test.{ts,tsx}',
            'sources/**/*.integration.spec.{ts,tsx}',
            'sources/**/*.e2e.test.{ts,tsx}',
        ],
        exclude: [
            ...resolveVitestFeatureTestExcludeGlobs(),
            // Owned by `vitest.legend-native.config.ts` (see the glob's docs above). Left in this
            // run they resolve Legend's web build and fail in `commitLayoutEffects` with
            // `target.addEventListener is not a function` - a resolution error wearing a red badge.
            NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB,
        ],
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
    resolve: {
        ...(base.resolve ?? {}),
        alias: base.resolve?.alias ?? [
            { find: '@', replacement: resolve('./sources') },
        ],
    },
    plugins: [vitestMjsShebangPlugin],
});
