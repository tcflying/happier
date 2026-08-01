import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

import type { ReducerState } from '../reducer';
import type { ToolCall } from '../../domains/messages/messageTypes';

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readStringField(value: unknown, key: string): string | null {
    const record = readObject(value);
    const field = record?.[key];
    return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
}

function collectSubagentSidechainIds(params: Readonly<{
    tool: ToolCall;
    messageId?: string | null;
}>): string[] {
    const ids = new Set<string>();
    const add = (value: string | null | undefined) => {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed.length > 0) {
            ids.add(trimmed);
        }
    };

    add(params.tool.id);
    add(params.messageId);
    add(readStringField(params.tool.input, 'sidechainId'));
    add(readStringField(params.tool.input, 'callId'));
    add(readStringField(params.tool.result, 'sidechainId'));
    add(readStringField(params.tool.result, 'callId'));

    return Array.from(ids);
}

function hasLinkedSubagentSidechainActivity(params: Readonly<{
    state: ReducerState;
    messageId: string;
    tool: ToolCall;
}>): boolean {
    if (!isSubAgentTranscriptToolName(params.tool.name)) return false;

    for (const id of collectSubagentSidechainIds(params)) {
        const chain = params.state.sidechains.get(id);
        if (chain && chain.length > 0) {
            return true;
        }
    }

    return false;
}

export function markRunningToolsUnavailable(params: Readonly<{
    state: ReducerState;
    completedAt: number;
    changed: Set<string>;
}>): void {
    const completedAt = Math.trunc(params.completedAt);
    if (!Number.isFinite(completedAt)) return;

    for (const [messageId, message] of params.state.messages.entries()) {
        const tool = message.tool;
        if (!tool) continue;
        if (tool.state !== 'running') continue;
        if (tool.startedAt === null) continue;
        if (tool.createdAt > completedAt) continue;
        if (hasLinkedSubagentSidechainActivity({ state: params.state, messageId, tool })) continue;

        tool.state = 'unavailable';
        tool.completedAt = completedAt;
        params.changed.add(messageId);
    }
}

export function markRunningStreamedToolsCompleted(params: Readonly<{
    state: ReducerState;
    completedAt: number;
    changed: Set<string>;
}>): void {
    const completedAt = Math.trunc(params.completedAt);
    if (!Number.isFinite(completedAt)) return;

    for (const [messageId, message] of params.state.messages.entries()) {
        const tool = message.tool;
        if (!tool) continue;
        if (tool.state !== 'running') continue;
        if (tool.startedAt === null) continue;
        if (tool.createdAt > completedAt) continue;
        if (tool.result === undefined) continue;
        if (tool.permission?.status === 'pending') continue;
        if (hasLinkedSubagentSidechainActivity({ state: params.state, messageId, tool })) continue;

        tool.state = 'completed';
        tool.completedAt = completedAt;
        params.changed.add(messageId);
    }
}
