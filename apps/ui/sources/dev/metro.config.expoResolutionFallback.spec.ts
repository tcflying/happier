import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('apps/ui/metro.config.js (Expo resolution fallbacks)', () => {
    const envSnapshot = { ...process.env };

    function requireFreshMetroConfig() {
        // Metro expects a CommonJS config, so this file uses `require`. Vitest does not reliably clear
        // the CommonJS require cache via `vi.resetModules()`, so clear it manually to allow per-test env.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const resolved = require.resolve('../../metro.config.js');
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../../metro.config.js');
    }

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    afterEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    it('stubs `expo-system-ui` on web', () => {
        const config = requireFreshMetroConfig();

        const expectedStubPath = path.resolve(__dirname, '../platform/stubs/expoSystemUiWebStub.ts');
        const result = config.resolver.resolveRequest(
            { resolveRequest: () => ({ type: 'empty' }) },
            'expo-system-ui',
            'web',
        );

        expect(result).toEqual({ type: 'sourceFile', filePath: expectedStubPath });
        expect(fs.existsSync(expectedStubPath)).toBe(true);
    });

    it('falls back to resolving hoisted Expo modules from the monorepo root node_modules', () => {
        const config = requireFreshMetroConfig();

        const result = config.resolver.resolveRequest(
            // Provide a minimal context; the default resolver can throw in this unit-test harness,
            // and the config should fall back to Node resolution rooted at the monorepo `node_modules`.
            {},
            'expo-modules-core',
            'web',
        );

        expect(result?.type).toBe('sourceFile');
        expect(String(result?.filePath)).toMatch(/[/\\\\]expo-modules-core[/\\\\].+[/\\\\]index\.ts$/u);
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
    });

    it('records the actual noble-hashes specifier and origin when resolver tracing is enabled', () => {
        process.env.HAPPIER_UI_METRO_RESOLUTION_TRACE = '1';
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = requireFreshMetroConfig();
        const originModulePath = path.resolve(
            __dirname,
            '../../../../node_modules/@noble/hashes/utils.js',
        );
        const result = config.resolver.resolveRequest(
            { originModulePath },
            '@noble/hashes/crypto',
            'web',
        );
        expect(result?.type).toBe('sourceFile');
        expect(typeof result?.filePath).toBe('string');
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(
            '"specifier":"@noble/hashes/crypto"',
        ));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(
            `"origin":"${originModulePath.replace(/\\/g, '\\\\')}"`,
        ));
    });

    it('resolves the HMR soak marker from an explicit external watch root', () => {
        const root = fs.mkdtempSync(path.join(tmpdir(), 'happier-hmr-soak-'));
        const markerPath = path.join(root, 'hmrSoakMarker.ts');
        fs.writeFileSync(markerPath, 'export const marker = "fixture";\n', 'utf8');
        process.env.HAPPIER_UI_HMR_SOAK_ROOT = root;
        try {
            const config = requireFreshMetroConfig();
            expect(config.watchFolders).toContain(root);
            expect(config.resolver.resolveRequest({}, 'happier-hmr-soak-marker', 'web')).toEqual({
                type: 'sourceFile',
                filePath: markerPath,
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('stubs Node os imports before Metro tries to hash builtin module ids', () => {
        const config = requireFreshMetroConfig();
        const expectedShimPath = path.resolve(__dirname, '../platform/nodeShims/nodeOsShim.ts');

        expect(config.resolver.resolveRequest({}, 'node:os', 'ios')).toEqual({
            type: 'sourceFile',
            filePath: expectedShimPath,
        });
        expect(config.resolver.resolveRequest({}, 'os', 'ios')).toEqual({
            type: 'sourceFile',
            filePath: expectedShimPath,
        });
        expect(fs.existsSync(expectedShimPath)).toBe(true);
    });

    it('keeps Watchman discovery enabled for explicit interactive stack development', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        process.env.HAPPIER_UI_METRO_MODE = 'development';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(true);
    });

    it('uses the deterministic Node crawler for an explicit non-interactive build', () => {
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.CI;
        process.env.HAPPIER_UI_METRO_MODE = 'build';

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(false);
    });

    it('limits Metro roots to UI dependencies without nested or project-root duplicates', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        process.env.HAPPIER_UI_METRO_MODE = 'development';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        const projectRoot = path.resolve(__dirname, '../..');
        const repoRoot = path.resolve(projectRoot, '../..');
        const watchFolders = (config.watchFolders as string[]).map((folder) => path.resolve(folder));
        const normalized = watchFolders.map((folder) => path.normalize(folder).toLowerCase());

        expect(watchFolders.length).toBeLessThanOrEqual(10);
        expect(new Set(normalized).size).toBe(normalized.length);
        expect(normalized).toContain(path.join(repoRoot, 'node_modules').toLowerCase());
        expect(normalized).toContain(path.join(repoRoot, 'packages', 'protocol').toLowerCase());
        expect(normalized).not.toContain(projectRoot.toLowerCase());
        expect(normalized).not.toContain(path.join(repoRoot, 'apps', 'server').toLowerCase());
        expect(normalized).not.toContain(path.join(repoRoot, 'packages', 'relay-server').toLowerCase());

        for (const [index, folder] of normalized.entries()) {
            const nestedUnderAnotherRoot = normalized.some((candidate, candidateIndex) =>
                candidateIndex !== index && folder.startsWith(`${candidate}${path.sep}`),
            );
            expect(nestedUnderAnotherRoot, `duplicate nested watch root: ${watchFolders[index]}`).toBe(false);
        }
    });

    it('disables Watchman in stack builds (HAPPIER_STACK_STACK set)', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(false);
    });
});
