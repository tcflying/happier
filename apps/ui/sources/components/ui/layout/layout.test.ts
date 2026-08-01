import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS } from '@/utils/platform/viewportClass';

const layoutState = vi.hoisted(() => ({
    isMac: false,
    isTauriDesktop: false,
    platformOs: 'web' as 'ios' | 'android' | 'web',
    windowDimensions: { width: 2048, height: 687 },
    localSettings: {
        uiContentWidthMode: 'full' as 'compact' | 'medium' | 'full',
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return layoutState.platformOs;
            },
            select: (options: Record<string, unknown>) =>
                options?.[layoutState.platformOs] ?? options?.default ?? options?.ios ?? options?.android,
        },
        Dimensions: {
            get: () => ({
                width: layoutState.windowDimensions.width,
                height: layoutState.windowDimensions.height,
                scale: 2,
                fontScale: 1,
            }),
        },
    });
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => layoutState.isMac,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => layoutState.isTauriDesktop,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({
        getState: () => ({
            localSettings: layoutState.localSettings,
        }),
    }),
}));

describe('layout', () => {
    beforeEach(() => {
        vi.resetModules();
        layoutState.isMac = false;
        layoutState.isTauriDesktop = false;
        layoutState.platformOs = 'web';
        layoutState.windowDimensions = { width: 2048, height: 687 };
        layoutState.localSettings = { uiContentWidthMode: 'full' };
    });

    it('uses full content width by default in Tauri desktop windows', async () => {
        layoutState.isTauriDesktop = true;

        const { layout } = await import('./layout');

        expect(layout.maxWidth).toBe(Number.POSITIVE_INFINITY);
    });

    it('uses compact content width for desktop headers when selected', async () => {
        layoutState.isTauriDesktop = true;
        layoutState.localSettings = { uiContentWidthMode: 'compact' };

        const { layout } = await import('./layout');

        expect(layout.maxWidth).toBe(850);
        expect(layout.headerMaxWidth).toBe(850);
    });

    it('uses full content width for web headers by default regardless of viewport class', async () => {
        layoutState.windowDimensions = { width: 2400, height: 1400 };

        const { layout } = await import('./layout');

        expect(layout.maxWidth).toBe(Number.POSITIVE_INFINITY);
        expect(layout.headerMaxWidth).toBe(Number.POSITIVE_INFINITY);
    });

    it('uses medium content width when selected', async () => {
        layoutState.localSettings = { uiContentWidthMode: 'medium' };

        const { layout } = await import('./layout');

        expect(layout.maxWidth).toBe(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.medium);
    });

    it('removes the content width cap when full width is selected', async () => {
        layoutState.localSettings = { uiContentWidthMode: 'full' };

        const { layout } = await import('./layout');

        expect(layout.maxWidth).toBe(Number.POSITIVE_INFINITY);
    });
});
