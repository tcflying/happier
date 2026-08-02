import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, type FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

import {
    buildChatListItems,
    buildChatListItemsCached,
    type ChatListItem,
    type ChatListItemsBuildCache,
} from '@/components/sessions/chatListItems';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { useSessionCatchingUpNewer } from '@/sync/store/hooks';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { buildTranscriptTurnsCached, type TranscriptTurn, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { buildTranscriptTurnUnits, type TranscriptToolGroupUnitItem } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { resolveLatestCommittedMessageId } from '@/components/sessions/transcript/resolveLatestCommittedMessageId';
import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX,
} from '@/components/sessions/transcript/_constants';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { useTranscriptOlderPagination } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    restoreWebTranscriptPrependByGrowth,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryPlatform,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type ChainTranscriptLoadOlderResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

type ChainTranscriptLoadOlderOptions = Readonly<{
    webPrependAnchor?: WebTranscriptScrollMetrics | null;
}>;

type ChainTranscriptListItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    }
    | TranscriptToolGroupUnitItem;

type ChainWebLocalHeightChangeAnchor = Readonly<{
    metrics: WebTranscriptScrollMetrics;
    mode: 'preserve-position' | 'follow-bottom';
    sessionId: string;
}>;

function buildMessagesById(messages: readonly Message[]): Record<string, Message> {
    const result: Record<string, Message> = {};
    for (const message of messages) {
        result[message.id] = message;
    }
    return result;
}

function findLatestThinkingMessage(messages: readonly Message[]): Extract<Message, { kind: 'agent-text' }> | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.kind === 'agent-text' && message.isThinking === true) {
            return message;
        }
    }
    return null;
}

/** Exact ownership: rows that render the message themselves (N2c: a tool unit owns its tool message). */
function doesItemOwnMessageId(item: ChainTranscriptListItem, messageId: string): boolean {
    if (item.kind === 'message') {
        return item.messageId === messageId;
    }
    if (item.kind === 'tool-group-tool') {
        return item.toolMessageId === messageId;
    }
    if (item.kind === 'tool-calls-group') {
        return item.toolMessageIds.includes(messageId);
    }
    if (item.kind !== 'turn') {
        return false;
    }
    if (item.turn.userMessageId === messageId) {
        return true;
    }
    return item.turn.content.some((entry) => {
        if (entry.kind === 'message') {
            return entry.messageId === messageId;
        }
        return entry.toolMessageIds.includes(messageId);
    });
}

/** Containment fallback: the header cap stands in for tools hidden behind a collapsed preview. */
function doesHeaderUnitContainMessageId(item: ChainTranscriptListItem, messageId: string): boolean {
    return item.kind === 'tool-group-header' && item.toolMessageIds.includes(messageId);
}

function findItemIndexForMessageId(items: readonly ChainTranscriptListItem[], messageId: string): number {
    const owningIndex = items.findIndex((item) => doesItemOwnMessageId(item, messageId));
    if (owningIndex >= 0) return owningIndex;
    return items.findIndex((item) => doesHeaderUnitContainMessageId(item, messageId));
}

function isWebScrollElementLike(value: unknown): value is HTMLElement {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<HTMLElement>;
    return (
        typeof candidate.scrollTop === 'number' &&
        typeof candidate.scrollHeight === 'number' &&
        typeof candidate.clientHeight === 'number'
    );
}

export const ChainTranscriptList = React.memo(function ChainTranscriptList(props: {
    sessionId: string;
    messages: Message[];
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
    forcePermissionPromptsInTranscript?: boolean;
    loadOlder?: () => Promise<ChainTranscriptLoadOlderResult>;
    jumpToMessageId?: string | null;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    messageWrapperTestIdPrefix?: string;
    // When the list is empty, the footer shows an initial-load spinner. Callers that know whether an
    // initial/older load is genuinely in flight (e.g. sidechain hydration) should pass `false` once
    // the load resolves empty so a legitimately loaded-but-empty list does not spin forever. When
    // omitted, the spinner is shown on an empty list (legacy behavior for the main transcript).
    isInitialLoadInFlight?: boolean;
}) {
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const messageIdsOldestFirst = React.useMemo(() => props.messages.map((message) => message.id), [props.messages]);
    const messagesById = React.useMemo(() => buildMessagesById(props.messages), [props.messages]);

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const linearItemsCacheRef = React.useRef<ChatListItemsBuildCache | null>(null);
    const turnsCacheRef = React.useRef<TranscriptTurnsBuildCache | null>(null);
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return buildTranscriptTurnsCached({
            cache: turnsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls,
            toolCallsGroupStrategy,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById, toolCallsGroupStrategy]);

    React.useEffect(() => {
        turnsCacheRef.current = turnsCache;
    }, [turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return buildChatListItemsCached({
            cache: linearItemsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById]);

    React.useEffect(() => {
        if (groupingMode === 'turns') {
            linearItemsCacheRef.current = null;
            return;
        }
        linearItemsCacheRef.current = linearCache?.cache ?? null;
    }, [groupingMode, linearCache]);

    const syncTuning = sync.getSyncTuning();
    const estimatedItemSize = syncTuning.transcriptFlashListEstimatedItemSize;
    const configuredBackwardPrefetchThresholdPx = syncTuning.transcriptBackwardPrefetchThresholdPx;
    // §13 catch-up overlay signal. The sidechain list is non-inverted and has no live-tail
    // pinned-following composer, so there is no pinned-following streaming case to gate OFF and no
    // composer inset to track — the overlay anchors to the bottom edge (`bottomInset` 0) and shows
    // whenever sync is catching this session up to newer activity (fail-closed signal).
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const flashListExtraData = React.useMemo(() => ({
        selectionVersion: transcriptMessageSelection.selectionVersion,
        toolRouteReducerVersion: transcriptSessionCommon.toolRoute.reducerVersion ?? 0,
    }), [
        transcriptMessageSelection.selectionVersion,
        transcriptSessionCommon.toolRoute.reducerVersion,
    ]);

    // Tool-group expansion state is keyed by anchor message ids (declared before the
    // items memo: N2c per-unit decomposition derives the list rows from it).
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );

    const items = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (groupingMode === 'turns') {
            // N2c stable virtualization units: turns decompose into per-unit rows so
            // intra-row tool-group growth becomes between-row insertion.
            const turns = turnsCache?.turns ?? [];
            return buildTranscriptTurnUnits({
                items: turns.map((turn) => ({ kind: 'turn', id: turn.id, turn })),
                getMessageById: (messageId) => messagesById[messageId] ?? null,
                isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
                collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
            });
        }
        return linearCache?.items ?? buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [expandedToolCallsAnchorMessageIds, groupToolCalls, groupingMode, linearCache, messageIdsOldestFirst, messagesById, transcriptToolCallsCollapsedPreviewCountSetting, turnsCache]);

    const latestCommittedMessageId = React.useMemo(() => resolveLatestCommittedMessageId(props.messages), [props.messages]);
    const latestThinkingMessage = React.useMemo(() => findLatestThinkingMessage(props.messages), [props.messages]);
    const latestThinkingMessageId = latestThinkingMessage?.id ?? null;
    const latestThinkingMessageActivityAtMs = latestThinkingMessage?.createdAt ?? null;
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (latestCommittedMessageId == null || latestThinkingMessageId == null) return;
        if (latestCommittedMessageId !== latestThinkingMessageId) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const timer = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(timer);
    }, [latestCommittedMessageId, latestThinkingMessageActivityAtMs, latestThinkingMessageId, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: latestCommittedMessageId != null && latestCommittedMessageId === latestThinkingMessageId,
            latestThinkingMessageId,
            latestCommittedMessageId,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedMessageId, latestThinkingMessageActivityAtMs, latestThinkingMessageId, staleMs, thinkingPulseNow]);

    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );
    const localTranscriptInteractionDeferredInitialPinRef = React.useRef(false);
    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        localTranscriptInteractionDeferredInitialPinRef.current = true;
    }, []);
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) !== expanded) {
            deferAutoPinAfterLocalTranscriptInteraction();
        }
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded, thinkingDefaultExpanded]);

    const listRef = React.useRef<FlashListRef<ChainTranscriptListItem> | null>(null);
    const itemsRef = React.useRef<ChainTranscriptListItem[]>(items);
    const loadOlderRef = React.useRef(props.loadOlder);
    const webScrollElementRef = React.useRef<HTMLElement | null>(null);
    const pendingWebLocalHeightChangeAnchorRef = React.useRef<ChainWebLocalHeightChangeAnchor | null>(null);
    const isLoadingOlderRef = React.useRef(false);
    const hasMoreOlderRef = React.useRef(true);
    const initialPinDoneRef = React.useRef(false);
    const listLayoutHeightRef = React.useRef(0);
    const listContentHeightRef = React.useRef(0);
    const jumpAbortRef = React.useRef<AbortController | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const jumpToMessageId =
        typeof props.jumpToMessageId === 'string' && props.jumpToMessageId.trim().length > 0
            ? props.jumpToMessageId.trim()
            : null;
    const testIdPrefix =
        typeof props.messageWrapperTestIdPrefix === 'string' && props.messageWrapperTestIdPrefix.trim().length > 0
            ? props.messageWrapperTestIdPrefix.trim()
            : 'transcript-message';

    React.useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    React.useEffect(() => {
        loadOlderRef.current = props.loadOlder;
    }, [props.loadOlder]);


    const waitForNextVisualUpdate = React.useCallback(async () => {
        await Promise.resolve();
        await Promise.resolve();
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            await new Promise<void>((resolve) => {
                raf(() => resolve());
            });
        }
    }, []);

    const buildWebPrependAnchor = React.useCallback((pinThresholdPx: number): WebTranscriptScrollMetrics | null => {
        const element = webScrollElementRef.current;
        if (!element) return null;
        const metrics: WebTranscriptScrollMetrics = {
            element,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        };
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        return metrics;
    }, []);

    const resolveTopPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: configuredBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, [configuredBackwardPrefetchThresholdPx]);

    const resolveViewportGuardThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: Number.NaN,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const startReachedThreshold = React.useMemo(() => {
        const thresholdPx = resolveTopPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveTopPrefetchThresholdPx]);

    const loadOlder = React.useCallback(async (options: ChainTranscriptLoadOlderOptions = {}): Promise<ChainTranscriptLoadOlderResult | null> => {
        const fn = loadOlderRef.current;
        if (!fn) return null;
        if (isLoadingOlderRef.current) return null;
        if (hasMoreOlderRef.current === false) return null;

        isLoadingOlderRef.current = true;
        try {
            const result = await fn();
            if (options?.webPrependAnchor && result.loaded > 0) {
                // D5 (evidence E10): rAF starvation must not stall the prepend-anchor restore.
                await waitForVisualUpdateWithTimeout({
                    waitForNextVisualUpdate,
                    timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                });
                restoreWebTranscriptPrependByGrowth(options.webPrependAnchor);
            }
            if (result.status === 'no_more' || result.hasMore === false) {
                hasMoreOlderRef.current = false;
            }
            return result;
        } finally {
            isLoadingOlderRef.current = false;
        }
    }, [waitForNextVisualUpdate]);

    const paginationLoadOlder = React.useCallback(async (): Promise<ChainTranscriptLoadOlderResult | null> => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' };
        }
        const viewportGuardThresholdPx = resolveViewportGuardThresholdPx(listLayoutHeightRef.current);
        return await loadOlder({ webPrependAnchor: buildWebPrependAnchor(viewportGuardThresholdPx) });
    }, [buildWebPrependAnchor, loadOlder, resolveViewportGuardThresholdPx]);

    // Single owner of user-triggered older pagination (plan D2): the machine-driven hook
    // replaces the deleted dwell scheduler (threshold exit -> enter re-arm, single flight,
    // suspension while offset <= 0, caller-timed cooldown, spinner-delayed indicator).
    const olderPagination = useTranscriptOlderPagination({
        enabled: typeof props.loadOlder === 'function',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveTopPrefetchThresholdPx(listLayoutHeight),
        cooldownMs: syncTuning.transcriptOlderLoadCooldownMs,
        spinnerDelayMs: syncTuning.transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => true,
        isTransactionOpen: () => false,
    });
    const resetOlderPagination = olderPagination.reset;

    React.useEffect(() => {
        hasMoreOlderRef.current = true;
        resetOlderPagination();
    }, [props.sessionId, resetOlderPagination]);

    const captureWebLocalHeightChangeAnchor = React.useCallback((): ChainWebLocalHeightChangeAnchor | null => {
        if (Platform.OS !== 'web') return null;
        const element = webScrollElementRef.current;
        if (!element) return null;
        const metrics: WebTranscriptScrollMetrics = {
            element,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        };
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        const viewportGuardThresholdPx = resolveViewportGuardThresholdPx(metrics.clientHeight);
        return {
            metrics,
            mode: getWebTranscriptDistanceFromBottom(metrics) <= viewportGuardThresholdPx
                ? 'follow-bottom'
                : 'preserve-position',
            sessionId: props.sessionId,
        };
    }, [props.sessionId, resolveViewportGuardThresholdPx]);

    const writeWebLocalHeightChangeScrollTop = React.useCallback((params: Readonly<{
        anchor: ChainWebLocalHeightChangeAnchor;
        targetScrollTop: number;
    }>): boolean => {
        const { element } = params.anchor.metrics;
        const previousOffsetY = element.scrollTop;
        try {
            element.scrollTop = params.targetScrollTop;
        } catch {
            return false;
        }
        const paginationSnapshot = olderPagination.getSnapshot();
        recordTranscriptViewportTelemetryEvent({
            type: 'scroll-write',
            writer: 'web-dom-restore',
            reason: 'content-size-change',
            sessionId: props.sessionId,
            platform: resolveTranscriptViewportTelemetryPlatform(Platform.OS),
            listImplementation: 'flash_v2',
            mode: params.anchor.mode === 'follow-bottom' ? 'follow-bottom' : 'restore-anchor',
            targetOffsetY: params.targetScrollTop,
            previousOffsetY,
            layoutHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
            distanceFromBottom: Math.max(0, element.scrollHeight - element.clientHeight - params.targetScrollTop),
            trigger: 'restore',
            domScrollTop: element.scrollTop,
            domScrollHeight: element.scrollHeight,
            domClientHeight: element.clientHeight,
            flashListContentHeight: listContentHeightRef.current,
            flashListLayoutHeight: listLayoutHeightRef.current,
            scrollable: isWebTranscriptScrollable({
                element,
                scrollTop: element.scrollTop,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
            }, 1),
            paginationPhase: paginationSnapshot.phase,
            paginationSuspendedReasons: paginationSnapshot.suspendedReasons,
            coldCount: itemsRef.current.length,
            hotCount: 0,
            pendingWebPrependAnchorKind: 'none',
            programmaticWebWrite: true,
            timestampMs: Date.now(),
        }, syncTuning);
        return true;
    }, [olderPagination, props.sessionId, syncTuning]);

    const applyWebLocalHeightChangeAnchor = React.useCallback((anchor: ChainWebLocalHeightChangeAnchor): void => {
        if (anchor.sessionId !== props.sessionId) return;
        const { element } = anchor.metrics;
        if (anchor.mode === 'follow-bottom') {
            const targetScrollTop = resolveWebTranscriptMaxScrollTop({
                element,
                scrollTop: element.scrollTop,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
            });
            if (targetScrollTop !== element.scrollTop) {
                writeWebLocalHeightChangeScrollTop({ anchor, targetScrollTop });
            }
            return;
        }

        const growth = Math.max(0, element.scrollHeight - anchor.metrics.scrollHeight);
        if (growth <= 0) return;
        writeWebLocalHeightChangeScrollTop({
            anchor,
            targetScrollTop: anchor.metrics.scrollTop + growth,
        });
    }, [props.sessionId, writeWebLocalHeightChangeScrollTop]);

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const isExpanded = params.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id));
        if (isExpanded !== params.expanded) {
            const webAnchor = captureWebLocalHeightChangeAnchor();
            pendingWebLocalHeightChangeAnchorRef.current = webAnchor;
            if (webAnchor?.mode !== 'follow-bottom') {
                deferAutoPinAfterLocalTranscriptInteraction();
            }
        }
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (params.expanded) {
                const anchor = params.toolMessageIds.length > 0 ? params.toolMessageIds[params.toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor.length > 0) {
                    next.add(anchor);
                }
            } else {
                for (const id of params.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, [
        captureWebLocalHeightChangeAnchor,
        deferAutoPinAfterLocalTranscriptInteraction,
        expandedToolCallsAnchorMessageIds,
    ]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const anchor = pendingWebLocalHeightChangeAnchorRef.current;
        if (!anchor) return;
        pendingWebLocalHeightChangeAnchorRef.current = null;
        applyWebLocalHeightChangeAnchor(anchor);
    }, [applyWebLocalHeightChangeAnchor, expandedToolCallsAnchorMessageIds, items.length]);

    const observeOlderPaginationScroll = React.useCallback((observation: number | Readonly<{
        offsetY: number;
        trigger?: 'scroll' | 'edge-reached';
        webMetrics?: WebTranscriptScrollMetrics | null;
    }>) => {
        const offsetY = typeof observation === 'number' ? observation : observation.offsetY;
        const webMetrics = typeof observation === 'number' ? null : observation.webMetrics ?? null;
        const trigger = typeof observation === 'number' ? undefined : observation.trigger;
        const layoutH = Platform.OS === 'web' && webMetrics ? webMetrics.clientHeight : listLayoutHeightRef.current;
        const contentH = Platform.OS === 'web' && webMetrics ? webMetrics.scrollHeight : listContentHeightRef.current;
        if (!Number.isFinite(offsetY)) return;
        const domOffsetY = Platform.OS === 'web' && webMetrics ? webMetrics.scrollTop : offsetY;
        if (layoutH <= 0 || contentH <= 0 || contentH <= layoutH) {
            olderPagination.onScrollObservation({ offsetY: domOffsetY, scrollable: false, trigger });
            if (Platform.OS === 'web') {
                const snapshot = olderPagination.getSnapshot();
                recordTranscriptViewportTelemetryEvent({
                    type: 'scroll-observed',
                    sessionId: props.sessionId,
                    platform: resolveTranscriptViewportTelemetryPlatform(Platform.OS),
                    listImplementation: 'flash_v2',
                    mode: 'user-unpinned',
                    reason: 'observed',
                    offsetY: domOffsetY,
                    layoutHeight: layoutH,
                    contentHeight: contentH,
                    distanceFromBottom: 0,
                    trigger: trigger ?? 'scroll',
                    ...(webMetrics ? {
                        domScrollTop: webMetrics.scrollTop,
                        domScrollHeight: webMetrics.scrollHeight,
                        domClientHeight: webMetrics.clientHeight,
                    } : {}),
                    flashListContentHeight: listContentHeightRef.current,
                    flashListLayoutHeight: listLayoutHeightRef.current,
                    scrollable: false,
                    paginationPhase: snapshot.phase,
                    paginationSuspendedReasons: snapshot.suspendedReasons,
                    coldCount: itemsRef.current.length,
                    hotCount: 0,
                    pendingWebPrependAnchorKind: 'none',
                    programmaticWebWrite: false,
                    timestampMs: Date.now(),
                }, syncTuning);
            }
            return;
        }
        const distanceFromBottom = Platform.OS === 'web' && webMetrics
            ? getWebTranscriptDistanceFromBottom(webMetrics)
            : Math.max(0, Math.trunc(contentH - layoutH - domOffsetY));
        // Follow-mode gate stays consumer-side (Lane D contract): no top prefetch while the
        // viewport sits within the bottom pin guard.
        const viewportGuardThresholdPx = resolveViewportGuardThresholdPx(layoutH);
        const scrollable = distanceFromBottom > viewportGuardThresholdPx;
        olderPagination.onScrollObservation({
            offsetY: domOffsetY,
            scrollable,
            trigger,
        });
        if (Platform.OS === 'web') {
            const snapshot = olderPagination.getSnapshot();
            recordTranscriptViewportTelemetryEvent({
                type: 'scroll-observed',
                sessionId: props.sessionId,
                platform: resolveTranscriptViewportTelemetryPlatform(Platform.OS),
                listImplementation: 'flash_v2',
                mode: 'user-unpinned',
                reason: 'observed',
                offsetY: domOffsetY,
                layoutHeight: layoutH,
                contentHeight: contentH,
                distanceFromBottom,
                trigger: trigger ?? 'scroll',
                ...(webMetrics ? {
                    domScrollTop: webMetrics.scrollTop,
                    domScrollHeight: webMetrics.scrollHeight,
                    domClientHeight: webMetrics.clientHeight,
                } : {}),
                flashListContentHeight: listContentHeightRef.current,
                flashListLayoutHeight: listLayoutHeightRef.current,
                scrollable,
                paginationPhase: snapshot.phase,
                paginationSuspendedReasons: snapshot.suspendedReasons,
                coldCount: itemsRef.current.length,
                hotCount: 0,
                pendingWebPrependAnchorKind: 'none',
                programmaticWebWrite: false,
                timestampMs: Date.now(),
            }, syncTuning);
        }
    }, [olderPagination, props.sessionId, resolveViewportGuardThresholdPx, syncTuning]);

    const pinToBottom = React.useCallback(() => {
        if (jumpToMessageId) return;
        if (initialPinDoneRef.current) return;
        if (localTranscriptInteractionDeferredInitialPinRef.current) return;
        if (items.length === 0) return;

        const layoutH = listLayoutHeightRef.current;
        const contentH = listContentHeightRef.current;
        if (layoutH <= 0 || contentH <= 0) return;

        initialPinDoneRef.current = true;
        try {
            const promise = listRef.current?.scrollToIndex({
                index: items.length - 1,
                animated: false,
                viewPosition: 1,
            });
            promise?.catch(() => {
                const fallbackOffset = Math.max(0, Math.trunc(estimatedItemSize * (items.length - 1)));
                try {
                    listRef.current?.scrollToOffset({ offset: fallbackOffset, animated: false });
                } catch {
                    // Best-effort only.
                }
            });
        } catch {
            // Best-effort only.
        }
    }, [items.length, jumpToMessageId]);

    React.useEffect(() => {
        pinToBottom();
    }, [pinToBottom]);

    React.useEffect(() => {
        if (!jumpToMessageId) return;

        jumpAbortRef.current?.abort();
        const controller = new AbortController();
        jumpAbortRef.current = controller;
        const signal = controller.signal;

        fireAndForget(
            (async () => {
                // Cap work to avoid infinite paging on malformed IDs.
                for (let i = 0; i < 25; i++) {
                    if (signal.aborted) return;
                    const index = findItemIndexForMessageId(itemsRef.current, jumpToMessageId);
                    if (index >= 0) {
                        try {
                            const promise = listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                            promise?.catch(() => {
                                const offset = Math.max(0, Math.trunc(estimatedItemSize * index));
                                try {
                                    listRef.current?.scrollToOffset({ offset, animated: true });
                                } catch {
                                    // Best-effort only.
                                }
                            });
                        } catch {
                            // Best-effort only.
                        }
                        return;
                    }

                    const result = await loadOlder();
                    if (!result) return;
                    if (signal.aborted) return;
                    if (result.status === 'no_more' || result.hasMore === false) return;

                    // Yield to allow store updates + list re-render before re-checking.
                    await Promise.resolve();
                    await Promise.resolve();
                }
            })(),
            { tag: 'ChainTranscriptList.jumpToMessageId' },
        );

        return () => controller.abort();
    }, [jumpToMessageId, loadOlder]);

    const renderItem = React.useCallback(({ item }: { item: ChainTranscriptListItem }) => {
        if (item.kind === 'turn') {
            return (
                <TurnViewWithSessionCommon
                    turn={item.turn}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    activeThinkingMessageId={activeThinkingMessageId}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                    setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                    resolveThinkingExpanded={resolveThinkingExpanded}
                    setThinkingExpanded={setThinkingExpanded}
                    interaction={props.interaction}
                    rollbackRanges={[]}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-header') {
            const headerGroupId = item.groupId;
            const headerToolMessageIds = item.toolMessageIds;
            const toolMessages = item.toolMessageIds
                .map((messageId) => messagesById[messageId] ?? null)
                .filter((message): message is Extract<Message, { kind: 'tool-call' }> => message?.kind === 'tool-call');
            return (
                <ToolCallsGroupUnitHeaderRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    toolMessages={toolMessages}
                    expanded={item.expanded}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: headerGroupId,
                        toolMessageIds: headerToolMessageIds,
                        expanded,
                    })}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-expand') {
            const expandGroupId = item.groupId;
            const expandToolMessageIds = item.toolMessageIds;
            return (
                <ToolCallsGroupUnitExpandRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    hiddenCount={item.hiddenCount}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: expandGroupId,
                        toolMessageIds: expandToolMessageIds,
                        expanded,
                    })}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-tool') {
            const toolMessage = messagesById[item.toolMessageId];
            if (toolMessage?.kind !== 'tool-call') return null;
            return (
                <ToolCallsGroupUnitToolRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    message={toolMessage}
                    expanded={item.expanded}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-footer') {
            return (
                <ToolCallsGroupUnitFooterRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-calls-group') {
            return (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={props.interaction}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind !== 'message') {
            return null;
        }

        const message = messagesById[item.messageId];
        if (!message) return null;
        const isThinking = message.kind === 'agent-text' && message.isThinking === true;

        return (
            <View testID={`${testIdPrefix}-${message.id}`}>
                <MessageViewWithSessionCommon
                    message={message}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    interaction={props.interaction}
                    activeThinkingMessageId={activeThinkingMessageId}
                    thinkingExpanded={isThinking ? resolveThinkingExpanded(message.id) : undefined}
                    onThinkingExpandedChange={isThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            </View>
        );
    }, [
        activeThinkingMessageId,
        expandedToolCallsAnchorMessageIds,
        messagesById,
        props.forcePermissionPromptsInTranscript,
        props.interaction,
        props.metadata,
        props.sessionId,
        resolveThinkingExpanded,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        testIdPrefix,
        transcriptSessionCommon.fork,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
        <FlashList
            ref={(node: FlashListRef<ChainTranscriptListItem> | null) => {
                listRef.current = node;
            }}
            style={{ flex: 1, minHeight: 0 }}
            data={items}
            extraData={flashListExtraData}
            keyExtractor={(item: ChainTranscriptListItem) => item.id}
            renderItem={renderItem}
            scrollEventThrottle={
                Platform.OS === 'web'
                    ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                    : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS
            }
            onLayout={(e: LayoutChangeEvent) => {
                const h = e?.nativeEvent?.layout?.height;
                if (typeof h !== 'number' || !Number.isFinite(h)) return;
                if (listLayoutHeightRef.current !== h) {
                    listLayoutHeightRef.current = h;
                    setListLayoutHeight(h);
                }
                pinToBottom();
            }}
            onContentSizeChange={(_w: number, h: number) => {
                if (typeof h !== 'number' || !Number.isFinite(h)) return;
                listContentHeightRef.current = h;
                pinToBottom();
            }}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                const yRaw =
                    e?.nativeEvent?.contentOffset?.y ??
                    (e?.nativeEvent as any)?.target?.scrollTop ??
                    (e as any)?.target?.scrollTop ??
                    null;
                if (typeof yRaw !== 'number' || !Number.isFinite(yRaw)) return;

                const eventTarget = (e?.nativeEvent as any)?.target ?? (e as any)?.target ?? null;
                const isWebScrollElement = isWebScrollElementLike(eventTarget);
                if (isWebScrollElement) {
                    webScrollElementRef.current = eventTarget;
                }

                // Mirror of the main ChatList genuine-top closer (ChatList.tsx:9645): the continuous
                // web DOM-scroll path reports the genuine top as a near-zero `scrollTop`. The browser
                // rounds `scrollTop` to an integer (dpr=1) or leaves a sub-pixel residue (Retina), so a
                // viewport resting at the very top is rarely EXACTLY 0 — a strict `=== 0` test mis-fires
                // and the genuine-top frame never re-arms. A plain 'scroll' trigger SUSPENDS the
                // older-pagination machine within the genuine-top band (offsetSuspended), so a viewport
                // parked inside the threshold (e.g. when the top rendered row is a tall tool group whose
                // height keeps the offset off zero until the genuine top is reached) never re-arms after
                // its cooldown. Classify only the genuine-top frame as 'edge-reached' so it satisfies
                // the machine's existing `allowsExactEdge` (-> `exactEdgeRetryEligible`) re-arm. Strictly
                // gated on web + within the `TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX` band (the machine
                // uses the SAME epsilon) so the band cannot widen and a mid-band frame cannot re-arm
                // (anti-burst preserved). The sidechain FlashList is always non-inverted (no
                // `listOrientation` machinery / scaleY transform), so the main fix's non-inverted guard
                // is satisfied here by construction.
                const isGenuineWebTopFrame =
                    Platform.OS === 'web' &&
                    isWebScrollElement &&
                    eventTarget.scrollTop >= 0 &&
                    eventTarget.scrollTop <= TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX;

                // FlashList's `onStartReached` is not reliably fired on all platforms (notably web),
                // so the pagination machine observes every scroll position.
                observeOlderPaginationScroll({
                    offsetY: yRaw,
                    trigger: isGenuineWebTopFrame ? 'edge-reached' : 'scroll',
                    webMetrics: isWebScrollElement
                        ? {
                            element: eventTarget,
                            scrollTop: eventTarget.scrollTop,
                            scrollHeight: eventTarget.scrollHeight,
                            clientHeight: eventTarget.clientHeight,
                        }
                        : null,
                });
            }}
            onStartReachedThreshold={startReachedThreshold}
            onStartReached={() => {
                const element = webScrollElementRef.current;
                if (element) {
                    observeOlderPaginationScroll({
                        offsetY: element.scrollTop,
                        trigger: 'edge-reached',
                        webMetrics: {
                            element,
                            scrollTop: element.scrollTop,
                            scrollHeight: element.scrollHeight,
                            clientHeight: element.clientHeight,
                        },
                    });
                    return;
                }
                const listHandle = listRef.current as (FlashListRef<ChainTranscriptListItem> & {
                    getAbsoluteLastScrollOffset?: () => number;
                }) | null;
                const nativeOffset = (() => {
                    try {
                        const value = listHandle?.getAbsoluteLastScrollOffset?.();
                        if (typeof value === 'number' && Number.isFinite(value)) return value;
                    } catch {
                        return null;
                    }
                    return null;
                })();
                if (typeof nativeOffset === 'number') {
                    observeOlderPaginationScroll({ offsetY: nativeOffset, trigger: 'edge-reached' });
                }
            }}
            ListHeaderComponent={
                props.header ? (
                    <View>{props.header}</View>
                ) : null
            }
            ListFooterComponent={
                <>
                    {items.length === 0 && props.isInitialLoadInFlight !== false ? (
                        <View testID="chain-transcript-loading-footer" style={{ paddingVertical: 12 }}>
                            <ActivitySpinner size="small" />
                        </View>
                    ) : null}
                    {props.footer ? <View>{props.footer}</View> : null}
                </>
            }
        />
        {olderPagination.isLoadingOlder ? <OlderLoadProgressOverlay /> : null}
        <CatchUpProgressOverlay
            isCatchingUp={isCatchingUpNewer}
            bottomInset={0}
            spinnerDelayMs={syncTuning.transcriptOlderLoadSpinnerDelayMs}
        />
        </View>
    );
});
