import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const metroFileMapRoot = path.dirname(require.resolve('metro-file-map/package.json'));

type NativeWatcherInstance = {
    onFileEvent(listener: (event: { relativePath: string }) => void): () => void;
    onError(listener: (error: unknown) => void): () => void;
    _handleEvent(relativePath: unknown): Promise<void>;
    startWatching(): Promise<void>;
    stopWatching(): Promise<void>;
};

type NativeWatcherConstructor = {
    new (
        root: string,
        options: { dot: boolean; globs: string[]; ignored?: RegExp },
    ): NativeWatcherInstance;
    isSupported(): boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeWatcher = require(
    path.join(metroFileMapRoot, 'src', 'watchers', 'NativeWatcher.js'),
).default as NativeWatcherConstructor;

function activeFsWatcherCount(): number {
    const processWithHandles = process as NodeJS.Process & {
        _getActiveHandles?: () => Array<{ constructor?: { name?: string } }>;
    };
    return (processWithHandles._getActiveHandles?.() ?? [])
        .filter((handle) => handle.constructor?.name === 'FSWatcher')
        .length;
}

describe('Metro native recursive watcher', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('ignores a Windows fs.watch event without a filename', async () => {
        const shouldSupportNativeWatcher = process.platform === 'darwin' || process.platform === 'win32';
        if (!shouldSupportNativeWatcher) return;

        const root = await mkdtemp(path.join(tmpdir(), 'happier-metro-native-watcher-null-event-'));
        tempDirs.push(root);
        const watcher = new NativeWatcher(root, {
            dot: true,
            globs: ['**/*.ts'],
        });
        const errors: unknown[] = [];
        const removeErrorListener = watcher.onError((error) => errors.push(error));

        try {
            await expect(watcher._handleEvent(null)).resolves.toBeUndefined();
            expect(errors).toEqual([]);
        } finally {
            removeErrorListener();
            await watcher.stopWatching();
        }
    });

    it('keeps a large Windows directory fixture within a constant handle budget across five restarts', async () => {
        const shouldSupportNativeWatcher = process.platform === 'darwin' || process.platform === 'win32';
        expect(NativeWatcher.isSupported()).toBe(shouldSupportNativeWatcher);
        if (!shouldSupportNativeWatcher) return;

        const root = await mkdtemp(path.join(tmpdir(), 'happier-metro-native-watcher-'));
        tempDirs.push(root);
        const fixtureDirs = Array.from({ length: 256 }, (_, index) =>
            path.join(root, `workspace-${index}`, 'src', 'nested'),
        );
        await Promise.all(fixtureDirs.map((dir) => mkdir(dir, { recursive: true })));

        for (let restart = 0; restart < 5; restart += 1) {
            const beforeHandles = activeFsWatcherCount();
            const watcher = new NativeWatcher(root, {
                dot: true,
                globs: ['**/*.ts'],
            });

            let rejectWatcherError: (error: unknown) => void = () => {};
            const watcherError = new Promise<never>((_resolve, reject) => {
                rejectWatcherError = reject;
            });
            const removeErrorListener = watcher.onError(rejectWatcherError);

            try {
                await watcher.startWatching();
                expect(activeFsWatcherCount() - beforeHandles).toBeLessThanOrEqual(2);

                const expectedRelativePath = path.relative(
                    root,
                    path.join(fixtureDirs[255], `changed-${restart}.ts`),
                );
                const observedChange = new Promise<void>((resolve) => {
                    const removeFileListener = watcher.onFileEvent((event) => {
                        if (path.normalize(event.relativePath) !== path.normalize(expectedRelativePath)) return;
                        removeFileListener();
                        resolve();
                    });
                });
                let eventTimeout: ReturnType<typeof setTimeout> | null = null;
                const eventTimedOut = new Promise<never>((_resolve, reject) => {
                    eventTimeout = setTimeout(
                        () => reject(new Error(`Timed out waiting for Metro watcher event after restart ${restart + 1}`)),
                        5_000,
                    );
                });

                await writeFile(path.join(root, expectedRelativePath), 'export const changed = true;\n', 'utf8');
                try {
                    await Promise.race([observedChange, watcherError, eventTimedOut]);
                } finally {
                    if (eventTimeout) clearTimeout(eventTimeout);
                }
            } finally {
                removeErrorListener();
                await watcher.stopWatching();
            }

            expect(activeFsWatcherCount()).toBeLessThanOrEqual(beforeHandles);
        }
    });
});
