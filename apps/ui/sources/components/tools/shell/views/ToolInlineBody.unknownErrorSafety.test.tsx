import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const unknownToolViewMock = vi.hoisted(() => vi.fn(() => null));

installToolShellCommonModuleMocks();

vi.mock('@/components/tools/renderers/system/UnknownToolView', () => ({
    UnknownToolView: unknownToolViewMock,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => unknownToolViewMock,
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
    ToolError: (props: any) => React.createElement('ToolError', props),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => React.createElement('CodeView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

describe('ToolInlineBody unknown error safety', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not append the parent raw ToolError when UnknownToolView owns the error result', async () => {
        const { ToolInlineBody } = await import('./ToolInlineBody');
        const screen = await renderScreen(React.createElement(ToolInlineBody, {
            mode: 'timeline',
            tool: {
                id: 'unknown-error',
                name: 'FutureTool',
                state: 'error',
                input: 'input text',
                result: { error: { message: 'failed', token: 'do-not-render' } },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
            },
            normalizedToolName: 'FutureTool',
            metadata: null,
            messages: [],
            detailLevel: 'summary',
            setHeaderActions: () => {},
        } as any));

        expect(unknownToolViewMock).toHaveBeenCalledOnce();
        expect(screen.findAllByType('ToolError' as any)).toHaveLength(0);
    });
});
