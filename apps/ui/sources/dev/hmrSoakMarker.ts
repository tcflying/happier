declare global {
    interface Window {
        __HAPPIER_HMR_SOAK_MARKER__?: string;
    }
}

export const HAPPIER_HMR_SOAK_MARKER = 'disabled';

if (typeof window !== 'undefined') {
    window.__HAPPIER_HMR_SOAK_MARKER__ = HAPPIER_HMR_SOAK_MARKER;
}
