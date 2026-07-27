import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
});

describe('Pierre worker asset availability', () => {
    it('marks the worker unavailable when either generated static asset is missing', async () => {
        (globalThis as { window?: unknown }).window = { location: { origin: 'https://happier.example' } };
        const fetchMock = vi.fn(async (url: string) => ({
            ok: !url.endsWith('pierre-diff-worker-wasm.js'),
            status: url.endsWith('pierre-diff-worker-wasm.js') ? 404 : 200,
        }));
        vi.stubGlobal('fetch', fetchMock);

        const assets = await import('./pierreWorkerAssetAvailability.web');
        await assets.ensurePierreWorkerAssetsAvailable();

        expect(assets.getPierreWorkerAssetAvailability()).toBe('unavailable');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('marks the worker available only after both generated static assets respond successfully', async () => {
        (globalThis as { document?: unknown }).document = { baseURI: 'https://happier.example/app/' };
        const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const assets = await import('./pierreWorkerAssetAvailability.web');
        await assets.ensurePierreWorkerAssetsAvailable();

        expect(assets.getPierreWorkerAssetAvailability()).toBe('available');
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            'https://happier.example/pierre-diff-worker.js',
            'https://happier.example/pierre-diff-worker-wasm.js',
        ]);
    });
});
