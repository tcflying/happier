import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '../transcriptTestHelpers';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let messageById: Record<string, any> = {};
const emptyStoredMessages: any[] = [];
let renderedToolCallsGroupViewProps: any[] = [];
let renderedToolCallsGroupViewWithCommonProps: any[] = [];

installTranscriptCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMessagesByIds: (_sessionId: string, messageIds: readonly string[]) => {
                const messages = messageIds.map((id) => messageById[id]).filter(Boolean);
                return messages.length > 0 ? messages : emptyStoredMessages;
            },
            useSessionForkSupportSource: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => null,
            useSessionMessagesReducerVersion: () => 0,
            useSessionWorkspacePath: () => null,
            useSetting: () => null,
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
  ToolCallsGroupView: (props: any) => {
    renderedToolCallsGroupViewProps.push(props);
    return React.createElement('ToolCallsGroupView', props);
  },
  ToolCallsGroupViewWithSessionCommon: (props: any) => {
    renderedToolCallsGroupViewWithCommonProps.push(props);
    return React.createElement('ToolCallsGroupViewWithSessionCommon', props);
  },
}));

function getRenderedToolCallsGroupViewProps() {
    return [...renderedToolCallsGroupViewProps, ...renderedToolCallsGroupViewWithCommonProps];
}

describe('ToolCallsGroupRow', () => {
  beforeEach(() => {
    messageById = {};
    renderedToolCallsGroupViewProps = [];
    renderedToolCallsGroupViewWithCommonProps = [];
  });

  it('forwards parent-provided transcript session common while keeping row-local tool lookup', async () => {
    const messageDisplayCommon = {
      sessionThinkingDisplayMode: 'inline',
      sessionThinkingInlineChrome: 'plain',
      sessionThinkingInlinePresentation: 'summary',
      transcriptMessageTimestampDisplayMode: 'never',
      transcriptStreamingMarkdownRenderingEnabled: false,
      transcriptStreamingPartialOutputEnabled: true,
      transcriptStreamingSettleDelayMs: 0,
      transcriptStreamingSmoothingEnabled: false,
      transcriptMessageSelectionEnabled: true,
      transcriptMessageSendToSessionEnabled: false,
      debugInformationEnabled: false,
      workspacePath: null,
    } satisfies TranscriptMessageDisplayCommon;
    const forkCommon = {
      executionRunsEnabled: false,
      sessionForkSupportSource: null,
      sessionReplayEnabled: false,
      sessionReplayMaxSeedChars: 120_000,
      sessionReplayStrategy: 'recent_messages',
      sessionReplaySummaryRunnerV1: null,
    } satisfies TranscriptForkCommon;
    const toolChromeCommon = {
      toolViewTimelineChromeMode: 'cards',
      transcriptToolCallsCollapsedPreviewCount: 1,
      transcriptToolCallsGroupShowBackground: false,
    } satisfies TranscriptToolChromeCommon;
    const toolRouteCommon = {
      messagesById: {},
      reducerState: null,
    } satisfies TranscriptToolRouteCommon;
    const toolMessage = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: { id: 'bash-1', name: 'Bash', state: 'completed', input: { command: 'pwd' } },
      children: [],
    };

    const { ToolCallsGroupRowWithSessionCommon } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRowWithSessionCommon as any, {
      sessionId: 's1',
      toolCallsGroupId: 'group-1',
      toolMessageIds: ['tool-1'],
      metadata: null,
      expanded: false,
      onSetExpanded: () => {},
      interaction: { canSendMessages: true, canApprovePermissions: true },
      getMessageById: (messageId: string) => (messageId === 'tool-1' ? toolMessage : null),
      forkCommon,
      messageDisplayCommon,
      toolChromeCommon,
      toolRouteCommon,
    }));

    expect(renderedToolCallsGroupViewProps).toHaveLength(0);
    expect(renderedToolCallsGroupViewWithCommonProps).toEqual([
      expect.objectContaining({
        toolMessages: [expect.objectContaining({ id: 'tool-1' })],
        forkCommon,
        messageDisplayCommon,
        toolChromeCommon,
        toolRouteCommon,
      }),
    ]);
  });

  it('uses the provided local lookup for tool rows that are not yet present in the global store', async () => {
    const toolMessageOne = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: { id: 'bash-1', name: 'Bash', state: 'completed', input: { command: 'pwd' } },
      children: [],
    };
    const toolMessageTwo = {
      kind: 'tool-call',
      id: 'tool-2',
      localId: null,
      createdAt: 2,
      tool: { id: 'bash-2', name: 'Bash', state: 'running', input: { command: 'ls' } },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1', 'tool-2'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return toolMessageOne;
            if (messageId === 'tool-2') return toolMessageTwo;
            return null;
          },
        }));

    expect(getRenderedToolCallsGroupViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({ id: 'tool-1' }),
            expect.objectContaining({ id: 'tool-2' }),
          ],
          status: 'running',
        }),
      ]),
    );
  });

  it('re-reads local streamed tools when the direct transcript reducer state advances', async () => {
    let localToolMessage = {
      kind: 'tool-call',
      id: 'tool-local-stream',
      localId: 'tool-local-stream',
      createdAt: 1,
      tool: {
        id: 'terminal-child-1',
        name: 'Bash',
        state: 'running',
        input: { command: 'echo live' },
        completedAt: null as number | null,
      },
      children: [],
    };
    const getMessageById = (messageId: string) => (
      messageId === 'tool-local-stream' ? localToolMessage : null
    );
    const common = {
      forkCommon: {
        executionRunsEnabled: false,
        sessionForkSupportSource: null,
        sessionReplayEnabled: false,
        sessionReplayMaxSeedChars: 120_000,
        sessionReplayStrategy: 'recent_messages',
        sessionReplaySummaryRunnerV1: null,
      },
      messageDisplayCommon: {
        sessionThinkingDisplayMode: 'inline',
        sessionThinkingInlineChrome: 'plain',
        sessionThinkingInlinePresentation: 'summary',
        transcriptMessageTimestampDisplayMode: 'never',
        transcriptStreamingMarkdownRenderingEnabled: false,
        transcriptStreamingPartialOutputEnabled: true,
        transcriptStreamingSettleDelayMs: 0,
        transcriptStreamingSmoothingEnabled: false,
        transcriptMessageSelectionEnabled: true,
        transcriptMessageSendToSessionEnabled: false,
        debugInformationEnabled: false,
        workspacePath: null,
      },
      toolChromeCommon: {
        toolViewTimelineChromeMode: 'cards',
        transcriptToolCallsCollapsedPreviewCount: 1,
        transcriptToolCallsGroupShowBackground: false,
      },
    };
    const { ToolCallsGroupRowWithSessionCommon } = await import('./ToolCallsGroupRow');
    const localToolMessageIds = ['tool-local-stream'];
    const stableReducerState = {} as any;
    const renderRow = (reducerVersion: number) => React.createElement(
      ToolCallsGroupRowWithSessionCommon as any,
      {
        sessionId: 's1',
        toolCallsGroupId: 'group-local-stream',
        toolMessageIds: localToolMessageIds,
        metadata: null,
        expanded: false,
        onSetExpanded: () => {},
        interaction: { canSendMessages: true, canApprovePermissions: true },
        getMessageById,
        ...common,
        toolRouteCommon: { messagesById: {}, reducerState: stableReducerState, reducerVersion },
      },
    );

    const screen = await renderScreen(renderRow(1));
    expect(getRenderedToolCallsGroupViewProps().at(-1)?.status).toBe('running');

    localToolMessage = {
      ...localToolMessage,
      tool: {
        ...localToolMessage.tool,
        state: 'completed',
        completedAt: 2,
      },
    };
    renderedToolCallsGroupViewProps = [];
    renderedToolCallsGroupViewWithCommonProps = [];
    await screen.update(renderRow(2));

    expect(getRenderedToolCallsGroupViewProps().at(-1)?.status).toBe('completed');
  });

  it('keeps pending-permission tool calls visible when the session is inactive (coerced to failed)', async () => {
    const toolMessageOne = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: {
        id: 'mcp-1',
        name: 'mcp__playwright__browser_navigate',
        state: 'running',
        input: { url: 'https://example.com' },
        permission: { id: 'perm-1', status: 'pending' },
      },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return toolMessageOne;
            return null;
          },
        }));

    expect(getRenderedToolCallsGroupViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({
              id: 'tool-1',
              tool: expect.objectContaining({
                state: 'error',
                permission: expect.objectContaining({ status: 'canceled' }),
              }),
            }),
          ],
        }),
      ]),
    );
  });

  it('keeps completed tool calls visible when the session is inactive (and coerces pending-permission tools to failed)', async () => {
    const completedToolMessage = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: {
        id: 'bash-1',
        name: 'Bash',
        state: 'completed',
        input: { command: 'pwd' },
        permission: { id: 'perm-1', status: 'approved' },
      },
      children: [],
    };
    const pendingToolMessage = {
      kind: 'tool-call',
      id: 'tool-2',
      localId: null,
      createdAt: 2,
      tool: {
        id: 'mcp-1',
        name: 'mcp__playwright__browser_navigate',
        state: 'running',
        input: { url: 'https://example.com' },
        permission: { id: 'perm-2', status: 'pending' },
      },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1', 'tool-2'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return completedToolMessage;
            if (messageId === 'tool-2') return pendingToolMessage;
            return null;
          },
        }));

    expect(getRenderedToolCallsGroupViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({ id: 'tool-1' }),
            expect.objectContaining({
              id: 'tool-2',
              tool: expect.objectContaining({
                state: 'error',
                permission: expect.objectContaining({ status: 'canceled' }),
              }),
            }),
          ],
          status: 'completed',
        }),
      ]),
    );
  });
});

afterEach(() => {
    resetTranscriptCommonModuleMockState();
});
