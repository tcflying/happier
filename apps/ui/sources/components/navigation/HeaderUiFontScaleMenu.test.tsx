import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from '@/components/ui/forms/dropdown/dropdownTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

const fontScaleState = vi.hoisted(() => ({
    value: 1,
    setValue: vi.fn(),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSettingMutable: () => [fontScaleState.value, fontScaleState.setValue],
    });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/scroll/useScrollRectIntoView', () => ({
    useScrollRectIntoViewRegistry: () => ({
        scrollRef: { current: null },
        onViewportLayout: vi.fn(),
        onContentSizeChange: vi.fn(),
        onScroll: vi.fn(),
        registerItemLayout: () => undefined,
    }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        const ReactModule = require('react');
        if (!props.open) return null;
        return ReactModule.createElement(
            ReactModule.Fragment,
            null,
            typeof props.children === 'function'
                ? props.children({ maxHeight: 320, maxWidth: 208, placement: props.placement ?? 'bottom' })
                : props.children,
        );
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => {
        const ReactModule = require('react');
        const { View } = require('react-native');
        return ReactModule.createElement(View, null, props.children);
    },
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => {
        const ReactModule = require('react');
        const { Pressable, Text, View } = require('react-native');
        const items = props.categories.flatMap((category: any) => category.items);

        return ReactModule.createElement(
            View,
            null,
            items.map((item: any, index: number) => ReactModule.createElement(
                Pressable,
                {
                    key: item.id,
                    testID: item.testID,
                    accessibilityState: { selected: index === props.selectedIndex },
                    onPress: () => props.onPressItem(item),
                },
                ReactModule.createElement(Text, null, item.title),
            )),
        );
    },
}));

describe('HeaderUiFontScaleMenu', () => {
    beforeEach(() => {
        fontScaleState.value = 1;
        fontScaleState.setValue.mockReset();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens a real dropdown with default, 1.2x, 1.5x, 2x, and 3x choices', async () => {
        const { HeaderUiFontScaleMenu } = await import('./HeaderUiFontScaleMenu');
        const screen = await renderScreen(<HeaderUiFontScaleMenu />);

        await screen.pressByTestIdAsync('header-ui-font-scale-menu');

        expect(screen.findByTestId('header-ui-font-scale-option-default')).toBeTruthy();
        expect(screen.findByTestId('header-ui-font-scale-option-xlarge')).toBeTruthy();
        expect(screen.findByTestId('header-ui-font-scale-option-one-and-half')).toBeTruthy();
        expect(screen.findByTestId('header-ui-font-scale-option-double')).toBeTruthy();
        expect(screen.findByTestId('header-ui-font-scale-option-triple')).toBeTruthy();
    });

    it('writes 1.2x, 1.5x, 2x, 3x, and 1x after the corresponding menu option is pressed', async () => {
        const { HeaderUiFontScaleMenu } = await import('./HeaderUiFontScaleMenu');
        const screen = await renderScreen(<HeaderUiFontScaleMenu />);

        await screen.pressByTestIdAsync('header-ui-font-scale-menu');
        await screen.pressByTestIdAsync('header-ui-font-scale-option-xlarge');
        await screen.pressByTestIdAsync('header-ui-font-scale-menu');
        await screen.pressByTestIdAsync('header-ui-font-scale-option-one-and-half');
        await screen.pressByTestIdAsync('header-ui-font-scale-menu');
        await screen.pressByTestIdAsync('header-ui-font-scale-option-double');
        await screen.pressByTestIdAsync('header-ui-font-scale-menu');
        await screen.pressByTestIdAsync('header-ui-font-scale-option-triple');
        await screen.pressByTestIdAsync('header-ui-font-scale-menu');
        await screen.pressByTestIdAsync('header-ui-font-scale-option-default');

        expect(fontScaleState.setValue.mock.calls).toEqual([[1.2], [1.5], [2], [3], [1]]);
    });

    it('marks the effective 1.5x choice as selected', async () => {
        fontScaleState.value = 1.5;
        const { HeaderUiFontScaleMenu } = await import('./HeaderUiFontScaleMenu');
        const screen = await renderScreen(<HeaderUiFontScaleMenu />);

        expect(screen.getTextContent()).toContain('1.5×');
        await screen.pressByTestIdAsync('header-ui-font-scale-menu');

        expect(screen.findByTestId('header-ui-font-scale-option-one-and-half')?.props.accessibilityState).toEqual({ selected: true });
    });
});
