import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const shared = vi.hoisted(() => ({
    uiFontScale: 1,
    setUiFontScale: vi.fn((next: number) => {
        shared.uiFontScale = next;
    }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { chrome: { header: { foreground: '#000' } } } },
    });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => key === 'uiFontScale' ? shared.uiFontScale : undefined) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
            useLocalSettingMutable: ((key: string) => [
                key === 'uiFontScale' ? shared.uiFontScale : undefined,
                shared.setUiFontScale,
            ]) as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
        },
    });
});

afterEach(() => {
    standardCleanup();
    shared.uiFontScale = 1;
    shared.setUiFontScale.mockClear();
});

describe('HeaderFontScaleAction', () => {
    it('offers the final seven presets and persists the selected scale', async () => {
        const { HeaderFontScaleAction } = await import('./HeaderFontScaleAction');
        const screen = await renderScreen(<HeaderFontScaleAction />);
        const menu = screen.findByType('DropdownMenu' as any)!;

        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'default', 'large', 'xlarge', 'xxlarge', 'xhuge', 'xxhuge', 'xxxhuge',
        ]);
        expect(menu.props.selectedId).toBe('default');

        await act(async () => {
            menu.props.onSelect('xxxhuge');
        });

        expect(shared.setUiFontScale).toHaveBeenCalledWith(3);
        expect(shared.uiFontScale).toBe(3);
    });

    it('shows a compatible appearance preset as the current selection', async () => {
        shared.uiFontScale = 0.8;
        const { HeaderFontScaleAction } = await import('./HeaderFontScaleAction');
        const screen = await renderScreen(<HeaderFontScaleAction />);

        const menu = screen.findByType('DropdownMenu' as any)!;
        expect(menu.props.selectedId).toBe('xxsmall');
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'xxsmall', 'default', 'large', 'xlarge', 'xxlarge', 'xhuge', 'xxhuge', 'xxxhuge',
        ]);
    });
});
