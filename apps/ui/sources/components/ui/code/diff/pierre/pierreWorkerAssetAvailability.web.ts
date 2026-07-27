export type PierreWorkerAssetAvailability = 'unknown' | 'checking' | 'available' | 'unavailable';

const PIERRE_WORKER_ASSET_PATHS = [
    '/pierre-diff-worker.js',
    '/pierre-diff-worker-wasm.js',
] as const;

let availability: PierreWorkerAssetAvailability = 'unknown';
let checkPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: PierreWorkerAssetAvailability): void {
    if (availability === next) return;
    availability = next;
    for (const listener of listeners) listener();
}

function resolveAssetUrl(pathname: string): string {
    const base = typeof window !== 'undefined' && typeof window.location?.origin === 'string'
        ? window.location.origin
        : (typeof document !== 'undefined' && typeof document.baseURI === 'string'
            ? document.baseURI
            : 'http://localhost');
    return new URL(pathname, base).toString();
}

export function getPierreWorkerAssetAvailability(): PierreWorkerAssetAvailability {
    return availability;
}

export function subscribePierreWorkerAssetAvailability(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function ensurePierreWorkerAssetsAvailable(): Promise<void> {
    if (availability === 'available' || availability === 'unavailable') return Promise.resolve();
    if (checkPromise) return checkPromise;
    if (typeof fetch !== 'function') {
        publish('unavailable');
        return Promise.resolve();
    }

    publish('checking');
    checkPromise = Promise.all(
        PIERRE_WORKER_ASSET_PATHS.map(async (pathname) => {
            const response = await fetch(resolveAssetUrl(pathname), {
                method: 'HEAD',
                cache: 'no-store',
            });
            if (!response.ok) throw new Error(`pierre_worker_asset_unavailable:${pathname}:${response.status}`);
        }),
    ).then(
        () => publish('available'),
        () => publish('unavailable'),
    ).finally(() => {
        checkPromise = null;
    });
    return checkPromise;
}
