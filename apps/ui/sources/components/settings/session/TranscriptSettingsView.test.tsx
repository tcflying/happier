import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setTranscriptMessageTimestampDisplayMode = vi.fn();
const setTranscriptMessageSelectionEnabled = vi.fn();
const setTranscriptMessageSendToSessionEnabled = vi.fn();
const setTranscriptMessageSendToSessionTemplate = vi.fn();
const setTranscriptBulkCopyFormat = vi.fn();

installSessionSettingsCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: (name: string) => {
                    if (name === 'transcriptGroupToolCalls') {
                        return [true, vi.fn()];
                    }
                    if (name === 'toolViewTimelineChromeMode') {
                        return ['activity_feed', vi.fn()];
                    }
                    if (name === 'transcriptMessageTimestampDisplayMode') {
                        return ['hover_web_hidden_mobile', setTranscriptMessageTimestampDisplayMode];
                    }
                    if (name === 'transcriptMessageSelectionEnabled') {
                        return [true, setTranscriptMessageSelectionEnabled];
                    }
                    if (name === 'transcriptMessageSendToSessionEnabled') {
                        return [false, setTranscriptMessageSendToSessionEnabled];
                    }
                    if (name === 'transcriptMessageSendToSessionTemplate') {
                        return ['{{MESSAGES}}', setTranscriptMessageSendToSessionTemplate];
                    }
                    if (name === 'transcriptBulkCopyFormat') {
                        return ['markdown_labeled', setTranscriptBulkCopyFormat];
                    }
                    return [null, vi.fn()];
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, footer, title }: { children?: React.ReactNode; footer?: string; title?: string }) =>
        React.createElement('ItemGroup', { footer, title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

describe('TranscriptSettingsView', () => {
    beforeEach(() => {
        setTranscriptMessageTimestampDisplayMode.mockClear();
        setTranscriptMessageSelectionEnabled.mockClear();
        setTranscriptMessageSendToSessionEnabled.mockClear();
        setTranscriptMessageSendToSessionTemplate.mockClear();
        setTranscriptBulkCopyFormat.mockClear();
    });

    it('renders message action controls in their own transcript settings group', async () => {
        const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const group = screen.findAll((node) =>
            String(node.type) === 'ItemGroup' && node.props?.title === 'settingsSession.transcript.messageActions.groupTitle'
        )[0];
        expect(group).toBeTruthy();
        expect(group.props.footer).toBe('settingsSession.transcript.messageActions.groupFooter');

        const selectionRow = screen.findByProps({ testID: 'settings-session-transcript-message-selection-enabled' });
        selectionRow.props.onPress?.();
        expect(setTranscriptMessageSelectionEnabled).toHaveBeenCalledWith(false);
        const selectionSwitch = selectionRow.props.rightElement as React.ReactElement<{ value: boolean; onValueChange: (value: boolean) => void }>;
        expect(selectionSwitch.props.value).toBe(true);
        selectionSwitch.props.onValueChange(false);
        expect(setTranscriptMessageSelectionEnabled).toHaveBeenCalledWith(false);

        const sendRow = screen.findByProps({ testID: 'settings-session-transcript-message-send-to-session-enabled' });
        sendRow.props.onPress?.();
        expect(setTranscriptMessageSendToSessionEnabled).toHaveBeenCalledWith(true);

        const templateField = screen.findByProps({ testID: 'settings-session-transcript-message-send-template-field' });
        expect(String(templateField.type)).toBe('View');

        const templateInput = screen.findByProps({ testID: 'settings-session-transcript-message-send-template-input' });
        const templateInputProps = templateInput.props as {
            accessibilityLabel?: string;
            value: string;
            onChangeText: (value: string) => void;
        };
        expect(templateInputProps.accessibilityLabel).toBe('settingsSession.transcript.messageActions.template.title');
        expect(templateInputProps.value).toBe('{{MESSAGES}}');
        templateInputProps.onChangeText('Before\n\n{{MESSAGES}}');
        expect(setTranscriptMessageSendToSessionTemplate).toHaveBeenCalledWith('Before\n\n{{MESSAGES}}');

        const formatDropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.messageActions.bulkCopyFormat.title'
        )[0];
        expect(formatDropdown).toBeTruthy();
        expect(formatDropdown.props.selectedId).toBe('markdown_labeled');
        expect(formatDropdown.props.items.map((item: any) => item.id)).toEqual(['markdown_labeled', 'plain']);
        formatDropdown.props.onSelect?.('plain');
        expect(setTranscriptBulkCopyFormat).toHaveBeenCalledWith('plain');
    });

    it('renders the message timestamp display dropdown in transcript layout settings', async () => {
        const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.messageTimestampsTitle'
        )[0];
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props?.selectedId).toBe('hover_web_hidden_mobile');
        expect(dropdown?.props?.items.map((item: any) => item.id)).toEqual([
            'hover_web_hidden_mobile',
            'hover_web_always_mobile',
            'always',
            'never',
        ]);

        let current = dropdown?.parent;
        let groupTitle: unknown;
        while (current) {
            if ((current.type as unknown) === 'ItemGroup') {
                groupTitle = current.props?.title;
                break;
            }
            current = current.parent;
        }
        expect(groupTitle).toBe('settingsSession.transcript.layoutTitle');

        dropdown?.props?.onSelect?.('always');

        expect(setTranscriptMessageTimestampDisplayMode).toHaveBeenCalledWith('always');
    });

    it('uses the collapsed tool-group default when the setting is unavailable', async () => {
        const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.advanced.toolCallsCollapsedPreviewCountTitle'
        )[0];

        expect(dropdown?.props?.selectedId).toBe('0');
    });
});
