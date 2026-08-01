import { describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

const settingValues: Record<string, unknown> = {
    sessionReplayEnabled: false,
    sessionReplayMaxSeedChars: 1200,
    sessionReplayStrategy: 'recent',
    sessionReplaySummaryRunnerV1: null,
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlineChrome: 'card',
    sessionThinkingInlinePresentation: 'summary',
    toolViewTimelineChromeMode: 'cards',
    transcriptMessageTimestampDisplayMode: 'hover_web_hidden_mobile',
    transcriptMessageSelectionEnabled: false,
    transcriptMessageSendToSessionEnabled: true,
    transcriptStreamingMarkdownRenderingEnabled: true,
    transcriptStreamingPartialOutputEnabled: true,
    transcriptStreamingSettleDelayMs: 90,
    transcriptStreamingSmoothingEnabled: true,
    transcriptToolCallsCollapsedPreviewCount: 5,
    transcriptToolCallsGroupShowBackground: true,
};
const stableMessagesById = {};
const stableReducerState = {} as any;
let reducerVersion = 0;

vi.mock('@/sync/domains/state/storage', () => ({
    useSessionForkSupportSource: () => null,
    useSessionMessagesById: () => stableMessagesById,
    useSessionMessagesReducerState: () => stableReducerState,
    useSessionMessagesReducerVersion: () => reducerVersion,
    useSessionWorkspacePath: () => '/repo',
    useLocalSetting: () => false,
    useSetting: (key: string) => settingValues[key],
}));

describe('useTranscriptSessionCommon', () => {
    it('includes row-level transcript message action settings in message display common', async () => {
        const { useTranscriptSessionCommon } = await import('./transcriptSessionCommon');
        const hook = await renderHook(() => useTranscriptSessionCommon('s1'));

        expect(hook.getCurrent().messageDisplay.transcriptMessageSelectionEnabled).toBe(false);
        expect(hook.getCurrent().messageDisplay.transcriptMessageSendToSessionEnabled).toBe(true);

        await hook.unmount();
        standardCleanup();
    });

    it('refreshes tool route common when the in-place reducer version advances', async () => {
        reducerVersion = 1;
        const { useTranscriptSessionCommon } = await import('./transcriptSessionCommon');
        const hook = await renderHook(() => useTranscriptSessionCommon('s1'));
        const firstToolRoute = hook.getCurrent().toolRoute;

        expect(firstToolRoute.reducerVersion).toBe(1);

        reducerVersion = 2;
        await hook.rerender();

        expect(hook.getCurrent().toolRoute.reducerVersion).toBe(2);
        expect(hook.getCurrent().toolRoute).not.toBe(firstToolRoute);

        await hook.unmount();
        standardCleanup();
    });
});
