import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstance, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

type SessionMachineTargetTestValue = { machineId: string; basePath: string } | null;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());
const sessionConnectedServicesAuthSwitchSpy = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string) => SessionMachineTargetTestValue>(() => null),
);
const readMachineControlTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(sessionId: string) => (SessionMachineTargetTestValue & { confidence?: string }) | null>(() => null),
);
const readDisplayMachineTargetForSessionSpy = vi.hoisted(() =>
  vi.fn<(input: unknown) => SessionMachineTargetTestValue>(() => null),
);
const resolveSessionWorkspacePresentationSpy = vi.hoisted(() => vi.fn((params: any) => ({
  groupKey: 'workspace',
  workspaceHash: 'hash',
  workspaceKey: 'workspace-key',
  pathKey: params?.target?.basePath ?? '',
  displayPath: params?.target?.basePath ?? '',
  displayTitle: params?.target?.basePath ?? '',
  customLabel: null,
  hasCustomLabel: false,
  machineId: params?.target?.machineId ?? null,
  machine: { id: params?.target?.machineId ?? 'unknown', metadata: null },
  machineLabel: params?.target?.machineId ?? 'unknown',
})));
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
  (globalThis as any).location.href = 'http://localhost/session/s1/previous';
  (globalThis as any).location.pathname = '/session/s1/previous';
}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const keyboardDismissSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android' }));
const responsiveState = vi.hoisted(() => ({ deviceType: 'phone' as 'phone' | 'tablet', isLandscape: false }));
const windowDimensionsState = vi.hoisted(() => ({ width: 800, height: 600 }));
const executionRunsFeatureState = vi.hoisted(() => ({ enabled: false }));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: false, serverId: null as string | null }));
const executionRunsBackendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const sessionMessagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const automationsSupportState = vi.hoisted(() => ({ enabled: false, serverId: null as string | null }));
const mobileWorkspaceExperienceState = vi.hoisted(() => ({
  value: undefined as 'classic' | 'cockpit' | undefined,
  setValue: vi.fn(),
}));
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));

vi.mock('react-native-reanimated', () => {
  const Animated = {
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
  };
  return {
    default: Animated,
    ...Animated,
    useAnimatedProps: () => ({}),
    useAnimatedStyle: () => ({}),
  };
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: () => null,
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'pane-scope-test',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    scopeState: null,
    openRight: vi.fn(),
    setRightTab: vi.fn(),
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: (props: any) => React.createElement('ChatHeaderView', props, props.rightElement ?? null),
}));
vi.mock('@/components/navigation/HeaderUiFontScaleMenu', () => ({
  HeaderUiFontScaleMenu: () => React.createElement('HeaderUiFontScaleMenu', { testID: 'header-ui-font-scale-menu' }),
}));
vi.mock('@/components/ui/feedback/AppUpdateStatusTag', () => ({
  AppUpdateStatusTag: (props: any) => React.createElement('AppUpdateStatusTag', props),
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
  SessionHeaderActionMenu: (props: any) => {
    headerActionMenuSpy(props);
    return React.createElement('SessionHeaderActionMenu');
  },
}));
vi.mock('@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch', () => ({
  useSessionConnectedServicesAuthSwitch: (props: unknown) => {
    sessionConnectedServicesAuthSwitchSpy(props);
    return { connectedServicesAuthChip: null, statusBadges: [] };
  },
}));
vi.mock('@/components/ui/icons/DependabotIcon', () => ({
  DependabotIcon: 'DependabotIcon',
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => executionRunsFeatureState.enabled,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
  useSessionExecutionRunsSupported: (_sessionId: string, scope?: { serverId?: string | null }) =>
    sessionExecutionRunsSupportedState.supported
    && (sessionExecutionRunsSupportedState.serverId == null || scope?.serverId === sessionExecutionRunsSupportedState.serverId),
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => executionRunsBackendsState.backends,
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: (scope?: { serverId?: string | null }) => ({
    enabled: automationsSupportState.enabled
      && (automationsSupportState.serverId == null || scope?.serverId === automationsSupportState.serverId),
  }),
}));
vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
  navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => responsiveState.deviceType,
  useHeaderHeight: () => 0,
  useIsLandscape: () => responsiveState.isLandscape,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
  useDraft: () => ({ clearDraft: vi.fn(), setDraftValue: vi.fn() }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
  subscribeActiveServer: () => () => {},
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    markSessionViewed: async () => {},
    fetchPendingMessages: async () => {},
    refreshSessions: async () => {},
    onSessionVisible: () => () => {},
    markSessionLiveTailIntent: () => {},
    ensureSidechainMessagesLoaded: async () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: { getMachineEncryption: () => null },
  },
}));
vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: vi.fn(),
  sessionAbort: vi.fn(),
  resumeSession: vi.fn(),
  sessionAttachmentsUploadFile: vi.fn(),
  sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  resolveMachineTargetForSessionFromState: (_state: unknown, sessionId: string) => readMachineTargetForSessionSpy(sessionId),
  resolveDisplayMachineTargetForSessionFromState: (_state: unknown, input: unknown) => readDisplayMachineTargetForSessionSpy(input),
  readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
  readMachineControlTargetForSession: (sessionId: string) => readMachineControlTargetForSessionSpy(sessionId),
  readDisplayMachineTargetForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input),
  readDisplayMachineIdForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input)?.machineId ?? '',
  readDisplayPathForSession: (input: unknown) => readDisplayMachineTargetForSessionSpy(input)?.basePath ?? '',
}));
vi.mock('@/sync/domains/session/listing/sessionWorkspacePresentation', () => ({
  resolveSessionWorkspacePresentation: (params: unknown) => resolveSessionWorkspacePresentationSpy(params),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: () => null,
}));
vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

installSessionShellCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const module = await createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      useWindowDimensions: () => ({ width: windowDimensionsState.width, height: windowDimensionsState.height }),
    });
    Object.defineProperty(module.Platform, 'OS', {
      configurable: true,
      get: () => platformState.os,
    });
    module.Platform.select = (spec: Record<string, unknown>) =>
      spec && Object.prototype.hasOwnProperty.call(spec, platformState.os)
        ? (spec as any)[platformState.os]
        : (spec as any).default;
    Object.assign(module.Keyboard, {
      dismiss: keyboardDismissSpy,
    });
    return module;
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        text: '#000',
        textSecondary: '#666',
        textLink: '#00f',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        surfaceSelected: '#eef4ff',
        divider: '#ddd',
        border: '#ddd',
        indigo: '#5856D6',
        radio: { active: '#007AFF' },
        accent: {
          blue: '#007AFF',
          green: '#34C759',
          orange: '#FF9500',
          yellow: '#FFCC00',
          red: '#FF3B30',
          indigo: '#5856D6',
          purple: '#AF52DE',
        },
        modal: { border: '#ddd' },
        input: { background: '#f5f5f5' },
        header: { tint: '#000' },
        status: { error: '#f00' },
        shadow: { color: '#000', opacity: 0.2 },
        groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
      },
    });
  },
  text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
      },
    }).module;
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
      },
    }).module;
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const getStorageStateForTest = () => ({
      sessions: { s1: sessionState.session },
      settings: {},
      sessionListViewDataByServerId: {},
    });
    return createStorageModuleStub({
      storage: Object.assign(
        (selector?: (state: any) => unknown) => {
          const state = getStorageStateForTest();
          return typeof selector === 'function' ? selector(state) : state;
        },
        { getState: getStorageStateForTest },
      ) as any,
      useSession: () => sessionState.session,
      useIsDataReady: () => true,
      useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
      useSessionMessages: () => ({ messages: sessionMessagesState.messages, isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useSessionPendingMessages: () => ({ messages: [] }),
      useSessionSubagentSourceMessages: () => sessionMessagesState.messages,
      useSessionRpcAvailabilityState: () => ({
        sessionExists: true,
        sessionRpcAvailable: true,
      }),
      useSessionReviewCommentsDrafts: () => [],
      useSessionUsage: () => null,
      useLocalSetting: (key: string) => {
        if (key === 'acknowledgedCliVersions') return {};
        if (key === 'uiMultiPanePanelsEnabled') return false;
        if (key === 'detailsPaneTabsBehavior') return 'preview';
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 520;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        return {};
      },
      useLocalSettingMutable: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') {
          throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
        }
        return [null, vi.fn()];
      },
      useSetting: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperienceState.value;
        return null;
      },
      useSettingMutable: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') {
          return [mobileWorkspaceExperienceState.value ?? null, mobileWorkspaceExperienceState.setValue];
        }
        return [null, vi.fn()];
      },
      useSettings: () => ({ experiments: true, featureToggles: {} }),
      useAutomations: () => [],
      useSessionAutomationsEnabledCount: () => 0,
      useOpenApprovalArtifactsForSession: () => [],
    });
  },
});

vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControl: () => false,
  shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

const { SessionView } = await import('./SessionView');

const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
  <AppPaneProvider>{children ?? null}</AppPaneProvider>
);

function findPressableByAccessibilityLabel(screen: RenderScreenResult, label: string) {
  return screen.findAll((node) => (node.type as unknown) === 'Pressable' && node.props?.accessibilityLabel === label)[0];
}

async function renderSessionView(routeServerId?: string) {
  const normalizedRouteServerId = routeServerId?.trim();
  if (normalizedRouteServerId) {
    sessionState.session = {
      ...sessionState.session,
      serverId: normalizedRouteServerId,
    };
  }
  return renderScreen(
    <SessionView id="s1" routeServerId={routeServerId} />,
    {
      wrapper: AppPaneProviderWrapper,
    },
  );
}

function getLastHeaderActionMenuProps(): any {
  const call = headerActionMenuSpy.mock.calls.at(-1);
  if (!call) throw new Error('Expected SessionHeaderActionMenu to render');
  return call[0];
}

function getHeaderExtraItemIds(props: any): string[] {
  return (props?.extraItems ?? []).map((item: any) => item?.id).filter(Boolean);
}

describe('SessionView header action menu visibility', () => {
  afterEach(() => {
    vi.useRealTimers();
    standardCleanup();
    sessionState.session = {
      id: 's1',
      metadata: null,
      accessLevel: 'edit',
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
    } as any;
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    sessionExecutionRunsSupportedState.serverId = null;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = false;
    automationsSupportState.serverId = null;
    mobileWorkspaceExperienceState.value = undefined;
    mobileWorkspaceExperienceState.setValue.mockReset();
    keyboardDismissSpy.mockReset();
    headerActionMenuSpy.mockClear();
    sessionConnectedServicesAuthSwitchSpy.mockClear();
    readMachineTargetForSessionSpy.mockReset();
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReset();
    readMachineControlTargetForSessionSpy.mockReturnValue(null);
    readDisplayMachineTargetForSessionSpy.mockReset();
    readDisplayMachineTargetForSessionSpy.mockReturnValue(null);
    resolveSessionWorkspacePresentationSpy.mockClear();
    routerPushSpy.mockReset();
    routerBackSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();
    windowDimensionsState.width = 800;
    windowDimensionsState.height = 600;
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
      writable: true,
      configurable: true,
    });
  });

  it('hides the open runs button when execution runs are unsupported for the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

    expect(openRunsButton).toBeUndefined();
  });

  it('places the font scale control inside the session header action row', async () => {
    const screen = await renderSessionView();

    expect(screen.findAllByTestId('header-ui-font-scale-menu')).toHaveLength(1);
    expect(screen.findAllByTestId('session-header-app-update-status-tag').length).toBeGreaterThan(0);
  });

  it('uses stable display target for workspace presentation instead of live reachable target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-live',
      basePath: '/repo/live',
    });
    readDisplayMachineTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-origin',
      basePath: '/repo/origin',
    });

    await renderSessionView();

    expect(readDisplayMachineTargetForSessionSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      metadata: sessionState.session.metadata,
    });
    expect(resolveSessionWorkspacePresentationSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        machineId: 'machine-origin',
        basePath: '/repo/origin',
      },
    }));
  });

  it('passes a validated session control target to connected-services auth switching', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReturnValue({
      machineId: 'machine-origin',
      basePath: '/repo/origin',
      confidence: 'metadata_direct',
    });

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-origin',
    }));
  });

  it('does not pass stale metadata machine id to connected-services auth switching without a control target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'machine-origin',
        path: '/repo/origin',
      },
    };
    readMachineTargetForSessionSpy.mockReturnValue(null);
    readMachineControlTargetForSessionSpy.mockReturnValue(null);

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: null,
    }));
  });

  it('does not block connected-services auth switching for stale in-progress projection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 0,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: null,
    };

    await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenCalledWith(expect.objectContaining({
      switchingDisabledReason: null,
    }));
  });

  it('refreshes connected-services auth switching when only runtime heartbeat freshness changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      active: true,
      activeAt: 0,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: null,
    };

    const screen = await renderSessionView();

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      switchingDisabledReason: null,
    }));

    sessionState.session = {
      ...sessionState.session,
      serverId: 'server-runtime-refresh',
      latestTurnStatusObservedAt: 1_000_000,
    };
    await screen.update(<SessionView id="s1" routeServerId="server-runtime-refresh" />);

    expect(sessionConnectedServicesAuthSwitchSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      switchingDisabledReason: 'active_turn',
    }));
    vi.useRealTimers();
  });

  it('shows the open runs button when the viewed session server supports execution runs', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = true;
    sessionExecutionRunsSupportedState.serverId = 'server-2';
    executionRunsBackendsState.backends = {
      codex: { available: true },
    };

    const screen = await renderSessionView('server-2');
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

    expect(openRunsButton).toBeDefined();
  });

  it('routes to session automations through blur-safe navigation', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = true;
    routerPushSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();

    const screen = await renderSessionView();
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();

    pressTestInstance(openAutomationsButton, 'session.openAutomations');

    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations?serverId=server-1');
  });

  it('shows automations for the viewed session server even when the active server differs', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = true;
    automationsSupportState.serverId = 'server-2';

    const screen = await renderSessionView('server-2');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();
  });

  it('folds runs and automations buttons into the header action menu when the header is narrow', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();

    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');
    expect(openRunsButton).toBeUndefined();
    expect(openAutomationsButton).toBeUndefined();
    expect(openSubagentsButton).toBeUndefined();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(0)?.[0] as any;
    const extraIds = getHeaderExtraItemIds(props);
    expect(extraIds).toContain('header.openRuns');
    expect(extraIds).toContain('header.openAutomations');
    expect(extraIds).toContain('header.openSubagents');
  });

  it('keeps folded header action menu items stable across unrelated session header updates', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();
    const firstExtraItems = getLastHeaderActionMenuProps().extraItems;

    headerActionMenuSpy.mockClear();
    sessionState.session = {
      ...sessionState.session,
      thinking: true,
      latestTurnStatus: 'running',
    };
    await screen.update(<SessionView id="s1" />);

    expect(getLastHeaderActionMenuProps().extraItems).toBe(firstExtraItems);
  });

  it('offers switching from default cockpit to classic on phones', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = undefined;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openMobileWorkspaceClassic');
  });

  it('offers switching from explicit classic to cockpit on phones', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = 'classic';

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).toContain('header.openMobileWorkspaceCockpit');
  });

  it('does not offer the mobile cockpit toggle on tablets', async () => {
    responsiveState.deviceType = 'tablet';
    mobileWorkspaceExperienceState.value = undefined;

    await renderSessionView();

    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openMobileWorkspaceClassic');
    expect(getHeaderExtraItemIds(getLastHeaderActionMenuProps())).not.toContain('header.openMobileWorkspaceCockpit');
  });

  it('updates the mobile workspace experience when the header toggle is selected', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = undefined;
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceClassic')).toBe(true);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('classic');

    standardCleanup();
    headerActionMenuSpy.mockClear();
    mobileWorkspaceExperienceState.setValue.mockReset();
    mobileWorkspaceExperienceState.value = 'classic';
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceCockpit')).toBe(true);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('cockpit');
  });

  it('dismisses the keyboard before opening cockpit from the session header toggle', async () => {
    responsiveState.deviceType = 'phone';
    mobileWorkspaceExperienceState.value = 'classic';
    await renderSessionView();

    expect(getLastHeaderActionMenuProps().onSelectExtraItem('header.openMobileWorkspaceCockpit')).toBe(true);

    expect(keyboardDismissSpy).toHaveBeenCalledTimes(1);
    expect(mobileWorkspaceExperienceState.setValue).toHaveBeenCalledWith('cockpit');
  });

  it('keeps the open runs button visible when the transcript already contains execution-run signals', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        kind: 'tool-call',
        tool: { name: 'SubAgentRun', input: { runId: 'run_1' }, result: { runId: 'run_1' } },
      },
    ];

    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

    expect(openRunsButton).toBeDefined();
  });

  it('renders a header subagents button when the transcript contains subagent activity', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        id: 'tool-msg-1',
        kind: 'tool-call',
        createdAt: 1,
        tool: {
          name: 'Task',
          id: 'toolu_task_1',
          input: { name: 'Investigate regression', team_name: 'qa-team', agent_id: 'alpha@qa-team' },
          result: { tool_use_result: { team_name: 'qa-team', agent_id: 'alpha@qa-team', name: 'alpha' } },
          state: 'running',
        },
      },
    ];

    const screen = await renderSessionView();
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');

    expect(openSubagentsButton).toBeDefined();
  });

  it('renders a header subagents button when launch surfaces are available even before any subagents exist', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = {
      codex: {
        available: true,
        intents: ['review', 'plan', 'delegate'],
      },
    };
    sessionMessagesState.messages = [];

    const screen = await renderSessionView();
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');

    expect(openSubagentsButton).toBeDefined();
  });

  it('renders SessionHeaderActionMenu even when automations and execution runs are disabled', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    headerActionMenuSpy.mockClear();
    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
  });

  it('renders a raised landscape back button on Android phones when the top header is hidden', async () => {
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = true;
    const screen = await renderSessionView();
    const landscapeBackButton = screen.findByTestId('session-view-landscape-back-button');
    pressTestInstance(landscapeBackButton);

    expect(landscapeBackButton).toBeTruthy();
    expect(landscapeBackButton?.props.hitSlop).toBe(15);
    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).toHaveBeenCalledTimes(1);
  });
});
