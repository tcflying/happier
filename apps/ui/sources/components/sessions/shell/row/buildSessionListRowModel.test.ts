import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';
import { createReducer } from '@/sync/reducer/reducer';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { sessionTagKey } from '../sessionTagUtils';
import { treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListRowModel } from './buildSessionListRowModel';
import type { SessionListRowPresentationSettings } from './sessionListRowModelTypes';

const NOW_MS = 1_000_000;

function createRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 10,
        createdAt: NOW_MS - 300_000,
        updatedAt: NOW_MS - 120_000,
        meaningfulActivityAt: null,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: `Session ${id}`,
            summaryText: null,
            path: `/repo/${id}`,
            homeDir: '/repo',
            host: 'workstation.local',
            machineId: 'machine-1',
            directSessionV1: null,
            readStateV1: null,
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: null,
        latestTurnStatusObservedAt: null,
        lastRuntimeIssue: null,
        ...overrides,
    };
}

function createSessionItem(
    session: SessionListRenderableSession,
    overrides: Partial<Extract<SessionListViewItem, { type: 'session' }>> = {},
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session,
        section: 'active',
        groupKey: 'group-a',
        groupKind: 'project',
        serverId: 'server-a',
        serverName: 'Server A',
        ...overrides,
    };
}

function createMessage(id: string, createdAt: number, seq = 1): Message {
    return {
        kind: 'agent-text',
        id,
        seq,
        localId: null,
        createdAt,
        text: `message ${id}`,
    };
}

function createContextCompactionMessage(
    id: string,
    phase: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled',
    createdAt: number,
): Message {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event: {
            type: 'context-compaction',
            phase,
            lifecycleId: 'compact-1',
            source: 'provider-event',
        },
    };
}

function createMessages(messages: readonly Message[] = []): SessionMessages {
    return {
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        messageRevisionsById: {},
        messagesMap: Object.fromEntries(messages.map((message) => [message.id, message])),
        reducerState: createReducer(),
        reducerVersion: 0,
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 1,
        isLoaded: true,
    } as SessionMessages;
}

function createPending(createdAtValues: readonly number[] = []): SessionPending {
    return {
        messages: createdAtValues.map((createdAt, index) => ({
            id: `pending-${index}`,
            localId: null,
            createdAt,
            updatedAt: createdAt,
            text: `pending ${index}`,
            rawRecord: null,
        })),
        discarded: [],
        isLoaded: true,
    };
}

function createSettings(
    overrides: Partial<SessionListRowPresentationSettings> = {},
): SessionListRowPresentationSettings {
    return {
        currentUserId: 'user-1',
        density: 'default',
        compact: false,
        compactMinimal: false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingTextMode: 'static',
        hideInactiveSessions: false,
        showServerBadge: false,
        showPinnedServerBadge: true,
        tagsEnabled: true,
        sessionTagsByKey: {},
        allKnownTags: [],
        pinnedSessionKeys: [],
        hasMultipleMachines: false,
        reachableSessionDisplayByKey: {},
        folderViewEnabled: true,
        relativeNowMs: NOW_MS,
        runtimeNowMs: NOW_MS,
        statusColors: {
            connected: 'connected-token',
            connecting: 'connecting-token',
            actionRequired: 'action-token',
            disconnected: 'disconnected-token',
            error: 'error-token',
            default: 'default-token',
        },
        ...overrides,
    };
}

describe('buildSessionListRowModel', () => {
    it('shows localized context-compaction status while the latest lifecycle is active', () => {
        const session = createRenderable('s1', { active: true, thinking: false });
        const model = buildSessionListRowModel({
            item: createSessionItem(session),
            state: {
                messages: createMessages([
                    createContextCompactionMessage('compact-start', 'started', NOW_MS - 1_000),
                ]),
            },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.status.statusText).toBe('正在压缩上下文...');
    });

    it('restores the general session status after compaction reaches a terminal phase', () => {
        const session = createRenderable('s1', { active: true, thinking: false });
        const model = buildSessionListRowModel({
            item: createSessionItem(session),
            state: {
                messages: createMessages([
                    createContextCompactionMessage('compact-start', 'started', NOW_MS - 2_000),
                    createContextCompactionMessage('compact-complete', 'completed', NOW_MS - 1_000),
                ]),
            },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.status.shouldShowStatus).toBe(false);
    });

    it('uses server-scoped row identity without collapsing same session ids from different servers', () => {
        const session = createRenderable('shared-id');
        const modelA = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-a' }),
            state: {},
            dataIndex: 2,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });
        const modelB = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-b' }),
            state: {},
            dataIndex: 3,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(modelA.rowKey).toBe(sessionTagKey('server-a', 'shared-id'));
        expect(modelB.rowKey).toBe(sessionTagKey('server-b', 'shared-id'));
        expect(modelA.rowKey).not.toBe(modelB.rowKey);
        expect(modelA.treeRowId).toBe(treeRowId.session('server-a', 'shared-id'));
        expect(modelA.testID).toBe('session-list-item-shared-id');
    });

    it('merges the store renderable overlay while preserving row-only pending flags and newer activity', () => {
        const rowSession = createRenderable('s1', {
            metadata: {
                name: 'Row Name',
                summaryText: null,
                path: '/repo/row',
                homeDir: '/repo',
                host: 'row.local',
                machineId: 'row-machine',
            },
            meaningfulActivityAt: 900,
            hasPendingPermissionRequests: true,
        });
        const storeRenderable = createRenderable('s1', {
            metadata: {
                name: 'Store Name',
                summaryText: null,
                path: '/repo/store',
                homeDir: '/repo',
                host: 'store.local',
                machineId: 'store-machine',
            },
            meaningfulActivityAt: 800,
            hasPendingPermissionRequests: false,
        });

        const model = buildSessionListRowModel({
            item: createSessionItem(rowSession),
            state: { renderable: storeRenderable },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.session.metadata?.name).toBe('Store Name');
        expect((model.session as SessionListRenderableSession).hasPendingPermissionRequests).toBe(true);
        expect((model.session as SessionListRenderableSession).meaningfulActivityAt).toBe(900);
    });

    it('derives date-group row activity from the raw updated-at timestamp', () => {
        const session = createRenderable('s1', {
            createdAt: NOW_MS - 900_000,
            updatedAt: NOW_MS - 240_000,
            meaningfulActivityAt: NOW_MS - 600_000,
        });
        const model = buildSessionListRowModel({
            item: createSessionItem(session, { groupKind: 'date' }),
            state: {
                messages: createMessages([createMessage('m1', NOW_MS - 120_000)]),
                pending: createPending([NOW_MS - 60_000]),
            },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ relativeNowMs: NOW_MS }),
        });

        expect(model.activity.mode).toBe('updatedAt');
        expect(model.activity.timestamp).toBe(NOW_MS - 240_000);
        expect(model.activity.label).toBe('4m');
    });

    it('keeps active attention status visible when the group would otherwise prefer a path subtitle', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - 10,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.secondaryLineMode).toBe('path');
        expect(model.attention.rowState).toBe('working');
        expect(model.presentation.secondaryLine).toBe('status');
        expect(model.status.state).toBe('thinking');
    });

    it('schedules runtime freshness from fresh active heartbeat when an in-progress observation is stale', () => {
        const activeAt = NOW_MS - 10;
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt,
                thinking: true,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.nextRuntimeFreshnessAtMs).toBe(activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    });

    it('schedules runtime freshness from active heartbeat for stale in-progress turns without legacy thinking', () => {
        const activeAt = NOW_MS - 10;
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.nextRuntimeFreshnessAtMs).toBe(activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    });

    it('does not schedule runtime freshness from meaningful activity alone', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - 10,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.nextRuntimeFreshnessAtMs).toBeNull();
    });

    it('does not schedule runtime freshness from legacy thinking after terminal turn projection', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10,
                thinking: true,
                thinkingAt: NOW_MS - 10,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: NOW_MS - 100,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.nextRuntimeFreshnessAtMs).toBeNull();
    });

    it('uses presentation-setting status colors instead of hidden default colors', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1')),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.status.statusColor).toBe('connected-token');
        expect(model.status.statusDotColor).toBe('connected-token');
    });

    it('uses server-scoped reachability subtitles for duplicate session ids', () => {
        const session = createRenderable('shared-id');
        const settings = createSettings({
            hasMultipleMachines: true,
            reachableSessionDisplayByKey: {
                [sessionTagKey('server-a', 'shared-id')]: {
                    machineLabel: 'MacBook',
                    workspaceSubtitle: 'Repo A',
                    workspaceSubtitleEllipsizeMode: 'tail',
                },
                [sessionTagKey('server-b', 'shared-id')]: {
                    machineLabel: 'Linux Box',
                    workspaceSubtitle: 'Repo B',
                    workspaceSubtitleEllipsizeMode: 'head',
                },
            },
        });

        const modelA = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-a' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings,
        });
        const modelB = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-b' }),
            state: {},
            dataIndex: 1,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings,
        });

        expect(modelA.subtitle).toBe('MacBook · Repo A');
        expect(modelA.subtitleEllipsizeMode).toBe('tail');
        expect(modelB.subtitle).toBe('Linux Box · Repo B');
        expect(modelB.subtitleEllipsizeMode).toBe('head');
    });

    it('preserves archived, pinned, unread, folder, and tag facts for presentational rows', () => {
        const session = createRenderable('s1', {
            archivedAt: NOW_MS - 1,
            hasUnreadMessages: true,
            pendingCount: 2,
        });
        const key = sessionTagKey('server-a', 's1');
        const model = buildSessionListRowModel({
            item: createSessionItem(session, {
                folderId: 'folder-a',
                folderDepth: 2,
                pinned: false,
                selected: true,
            } as Partial<Extract<SessionListViewItem, { type: 'session' }> & { selected: true }>),
            state: { pending: createPending([NOW_MS - 50_000, NOW_MS - 40_000]) },
            dataIndex: 5,
            isFirst: false,
            isLast: true,
            isSingle: false,
            settings: createSettings({
                pinnedSessionKeys: [key],
                sessionTagsByKey: { [key]: ['review', 'urgent'] },
                allKnownTags: ['review', 'urgent'],
            }),
        });

        expect(model.isArchived).toBe(true);
        expect(model.isPinned).toBe(true);
        expect(model.isSelected).toBe(true);
        expect(model.hasUnreadMessages).toBe(true);
        expect(model.pendingCount).toBe(2);
        expect(model.folder.id).toBe('folder-a');
        expect(model.folder.depth).toBe(2);
        expect(model.tags).toEqual(['review', 'urgent']);
        expect(model.adjacency).toEqual({ isFirst: false, isLast: true, isSingle: false });
    });
});
