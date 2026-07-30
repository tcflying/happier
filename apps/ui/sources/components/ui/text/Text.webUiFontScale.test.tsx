import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingState = vi.hoisted(() => ({
    uiFontScale: 1,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Text: (props: any) => React.createElement('RNText', props, props.children),
        TextInput: (props: any) => React.createElement('RNTextInput', props, props.children),
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => localSettingState.uiFontScale,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('Text web UI font scaling', () => {
    beforeEach(() => {
        localSettingState.uiFontScale = 1;
    });

    it('scales plain inline Web metrics once in the App Text layer', async () => {
        localSettingState.uiFontScale = 2;
        const { Text, TextInput } = await import('./Text');

        const textScreen = await renderScreen(<Text style={{ fontSize: 10, lineHeight: 12 }}>hello</Text>);
        const inputScreen = await renderScreen(<TextInput style={{ fontSize: 10, lineHeight: 12 }} />);

        expect(flattenStyle(textScreen.findByType('RNText' as any).props.style)).toMatchObject({
            fontSize: 20,
            lineHeight: 24,
        });
        expect(flattenStyle(inputScreen.findByType('RNTextInput' as any).props.style)).toMatchObject({
            fontSize: 20,
            lineHeight: 24,
        });
        expect(textScreen.findByType('RNText' as any).props.dataSet).toEqual({ happierUiFontScale: 'disabled' });
        expect(inputScreen.findByType('RNTextInput' as any).props.dataSet).toEqual({ happierUiFontScale: 'disabled' });
    });

    it('scales the React Native Web default font size for bare and color-only App Text', async () => {
        const { Text, TextInput } = await import('./Text');

        localSettingState.uiFontScale = 2;
        const bareTextScreen = await renderScreen(<Text>hello</Text>);
        expect(flattenStyle(bareTextScreen.findByType('RNText' as any).props.style).fontSize).toBe(28);

        localSettingState.uiFontScale = 3;
        const colorOnlyScreen = await renderScreen(<Text style={{ color: 'red' }}>hello</Text>);
        const bareInputScreen = await renderScreen(<TextInput />);
        expect(flattenStyle(colorOnlyScreen.findByType('RNText' as any).props.style)).toMatchObject({
            color: 'red',
            fontSize: 42,
        });
        expect(flattenStyle(bareInputScreen.findByType('RNTextInput' as any).props.style).fontSize).toBe(42);
    });

    it('leaves Web Unistyles secrets to the CSS owner without opting the DOM node out', async () => {
        localSettingState.uiFontScale = 2;
        const { Text } = await import('./Text');
        const secret = {
            uni__getStyles: () => ({ fontSize: 10, lineHeight: 12 }),
            uni__dependencies: [],
        };
        const style = { unistyles_web_text: secret } as any;

        const screen = await renderScreen(<Text style={style}>hello</Text>);
        const text = screen.findByType('RNText' as any);
        const appliedStyle = (text.props.style as any[]).find((entry) => entry?.unistyles_web_text);

        expect(appliedStyle.unistyles_web_text.uni__getStyles()).toMatchObject({
            fontSize: 10,
            lineHeight: 12,
        });
        expect(text.props.dataSet).toBeUndefined();
    });

    it('scales a top-level Unistyles color-only Text from the Web default size', async () => {
        localSettingState.uiFontScale = 2;
        const { Text } = await import('./Text');
        const secret = {
            uni__getStyles: () => ({ color: 'blue' }),
            uni__dependencies: [],
        };

        const screen = await renderScreen(
            <Text style={{ unistyles_color_only: secret } as any}>hello</Text>,
        );
        const text = screen.findByType('RNText' as any);

        expect(flattenStyle(text.props.style).fontSize).toBe(28);
        expect(text.props.dataSet).toEqual({ happierUiFontScale: 'disabled' });
    });

    it('adds the scaled default font size while CSS owns a line-height-only Unistyles metric', async () => {
        localSettingState.uiFontScale = 2;
        const { Text } = await import('./Text');
        const secret = {
            uni__getStyles: () => ({ color: 'blue', lineHeight: 20 }),
            uni__dependencies: [],
        };

        const screen = await renderScreen(
            <Text style={{ unistyles_line_height_only: secret } as any}>hello</Text>,
        );
        const text = screen.findByType('RNText' as any);
        const appliedStyle = (text.props.style as any[]).find((entry) => entry?.unistyles_line_height_only);

        expect(flattenStyle(text.props.style).fontSize).toBe(28);
        expect(appliedStyle.unistyles_line_height_only.uni__getStyles().lineHeight).toBe(20);
        expect(text.props.dataSet).toBeUndefined();
    });

    it('lets nested color-only Text inherit its scaled parent font size', async () => {
        localSettingState.uiFontScale = 2;
        const { Text } = await import('./Text');

        const screen = await renderScreen(
            <Text style={{ fontSize: 13 }}>
                parent
                <Text style={{ color: 'red' }}>child</Text>
            </Text>,
        );
        const textNodes = screen.findAllByType('RNText' as any);
        const outer = textNodes.find((node) => Array.isArray(node.props.children));
        const inner = textNodes.find((node) => node.props.children === 'child');

        expect(flattenStyle(outer?.props.style).fontSize).toBe(26);
        expect(flattenStyle(inner?.props.style).fontSize).toBeUndefined();
        expect(inner?.props.dataSet).toEqual({ happierUiFontScale: 'disabled' });
    });

    it('uses one JS override for mixed Unistyles and inline numeric metrics', async () => {
        localSettingState.uiFontScale = 2;
        const { Text } = await import('./Text');
        const secret = {
            uni__getStyles: () => ({ fontSize: 12, lineHeight: 16, color: 'blue' }),
            uni__dependencies: [],
        };

        const screen = await renderScreen(
            <Text style={[
                { unistyles_web_text: secret } as any,
                { fontSize: 10, color: 'red' },
            ]}>
                hello
            </Text>,
        );
        const text = screen.findByType('RNText' as any);

        expect(flattenStyle(text.props.style)).toMatchObject({
            color: 'red',
            fontSize: 20,
            lineHeight: 32,
        });
        expect(text.props.dataSet).toEqual({ happierUiFontScale: 'disabled' });
    });

    it('marks opt-out text so the Web CSS scaling owner can leave it unchanged', async () => {
        localSettingState.uiFontScale = 3;
        const { Text } = await import('./Text');

        const screen = await renderScreen(
            <Text
                disableUiFontScaling
                dataSet={{ existingMarker: 'kept' }}
                style={{ fontSize: 12 }}
            >
                3×
            </Text>,
        );
        const text = screen.findByType('RNText' as any);

        expect(flattenStyle(text.props.style).fontSize).toBe(12);
        expect(text.props.dataSet).toEqual({
            existingMarker: 'kept',
            happierUiFontScale: 'disabled',
        });
    });
});
