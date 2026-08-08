import * as React from 'react';
import { View, ViewStyle } from 'react-native';
import { t } from '@/text';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { SessionWarningActionBanner } from '@/components/sessions/shell/SessionWarningActionBanner';
import type { SessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';

export type ChatFooterDirectControlState = Readonly<{
    machineOnline: boolean;
    runnerActive: boolean;
    activity: 'running' | 'active_recently' | 'idle' | 'unknown';
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    providerLabel: string;
    trustedPid?: number | null;
    ownerPid?: number | null;
    ownerHappierSessionId?: string | null;
    takeoverInFlight: 'direct' | 'persisted' | null;
    onRequestTakeOverDirect?: () => void | Promise<void>;
    onRequestTakeOverPersist?: () => void | Promise<void>;
}> | null;

type ChatFooterNotice = Readonly<{ title: string; body: string }>;

interface ChatFooterProps {
    controlledByUser?: boolean;
    localControl?: SessionLocalControlState | null;
    permissionsInUiWhileLocal?: boolean;
    notice?: ChatFooterNotice | null;
    /**
     * UI-only ephemeral state while a local-controlled session is switching back to remote.
     * This is intentionally not persisted to the session transcript.
    */
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
    const containerStyle: ViewStyle = {
        // Allow children to take full width so long banners can wrap instead of overflowing
        alignItems: 'stretch',
        paddingTop: 4,
        paddingBottom: 2,
    };

    const localControlBanner = React.useMemo(() => {
        const localControl = props.localControl ?? null;
        if (!localControl && !props.controlledByUser) return null;

        const derived = localControl ?? {
            attached: props.controlledByUser === true,
            topology: 'exclusive',
            remoteWritable: false,
            canAttach: false,
            canDetach: props.controlledByUser === true,
        } satisfies SessionLocalControlState;

        const switchingToRemote = props.controlSwitchTo === 'remote';
        if (!derived.attached) return null;

        const isSharedAttached = derived.attached && derived.topology === 'shared';
        const showSwitchToRemoteButton =
            derived.attached
            && derived.topology === 'exclusive'
            && !switchingToRemote
            && Boolean(props.onRequestSwitchToRemote);
        const showDetachButton =
            derived.attached
            && derived.topology === 'shared'
            && !switchingToRemote
            && derived.canDetach
            && Boolean(props.onRequestSwitchToRemote);
        if (derived.remoteWritable && !switchingToRemote && !showSwitchToRemoteButton && !showDetachButton) {
            return null;
        }
        const textKey = (() => {
            if (switchingToRemote) return 'chatFooter.switchingToRemote';
            if (isSharedAttached) return 'chatFooter.sessionRunningLocallyAndRemotely';
            if (props.permissionsInUiWhileLocal) return 'chatFooter.sessionRunningLocally';
            return 'chatFooter.permissionsTerminalOnly';
        })();

        const actionLabelKey = showSwitchToRemoteButton
            ? 'chatFooter.switchToRemote'
            : showDetachButton
                ? 'chatFooter.detachLocalTerminal'
                : null;
        const actionTestID = showSwitchToRemoteButton
            ? 'session-chatFooter-switchToRemote'
            : showDetachButton
                ? 'session-chatFooter-detachLocalTerminal'
                : undefined;

        return (
            <ComposerAuxiliaryFrame>
                <SessionWarningActionBanner
                    testID="session-chatFooter-localControl"
                    iconName="info"
                    body={t(textKey)}
                    actionTestID={actionTestID}
                    actionLabel={actionLabelKey ? t(actionLabelKey) : undefined}
                    actionAccessibilityLabel={actionLabelKey ? t(actionLabelKey) : undefined}
                    onActionPress={actionLabelKey ? props.onRequestSwitchToRemote : undefined}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [
        props.controlSwitchTo,
        props.controlledByUser,
        props.localControl,
        props.onRequestSwitchToRemote,
        props.permissionsInUiWhileLocal,
    ]);

    const directModeBanner = React.useMemo(() => {
        if (!props.directControl || props.directControl.runnerActive) return null;

        const switchingToDirect = props.directControl.takeoverInFlight === 'direct';
        const switchingToPersisted = props.directControl.takeoverInFlight === 'persisted';
        const ownerHappierSessionId = props.directControl.ownerHappierSessionId?.trim() ?? '';
        const ownerPid = props.directControl.ownerPid;
        const authoritativeOtherOwner = ownerHappierSessionId.length > 0 && typeof ownerPid === 'number';
        const showDirectAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverDirect
            && typeof props.directControl.onRequestTakeOverDirect === 'function';
        const showPersistAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverPersist
            && typeof props.directControl.onRequestTakeOverPersist === 'function';

        const body = (() => {
            if (switchingToPersisted) return t('chatFooter.switchingToPersistedTakeover');
            if (switchingToDirect) return t('chatFooter.switchingToDirectTakeover');
            if (!props.directControl.machineOnline) return t('chatFooter.directSessionMachineOffline');
            if (authoritativeOtherOwner) {
                return t('chatFooter.directSessionControlledByOtherHappier', {
                    session: ownerHappierSessionId,
                    pid: ownerPid,
                });
            }
            return t('chatFooter.directSessionTakeoverAvailable');
        })();

        return (
            <ComposerAuxiliaryFrame>
                <SessionWarningActionBanner
                    testID="session-chatFooter-directControl"
                    iconName="info"
                    body={body}
                    secondaryActions={showPersistAction
                        ? [{
                            key: 'takeOverPersist',
                            testID: 'session-chatFooter-takeOverPersist',
                            label: t('chatFooter.takeOverPersist'),
                            accessibilityLabel: t('chatFooter.takeOverPersist'),
                            onPress: props.directControl.onRequestTakeOverPersist!,
                        }]
                        : undefined}
                    actionTestID={showDirectAction ? 'session-chatFooter-takeOverDirect' : undefined}
                    actionLabel={showDirectAction ? t('chatFooter.takeOverDirect') : undefined}
                    actionAccessibilityLabel={showDirectAction ? t('chatFooter.takeOverDirect') : undefined}
                    onActionPress={showDirectAction ? props.directControl.onRequestTakeOverDirect : undefined}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [props.directControl]);

    return (
        <View style={containerStyle}>
            {directModeBanner}
            {localControlBanner}
            {props.notice ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
                        testID="session-chatFooter-notice"
                        tone="neutral"
                        iconName={null}
                        title={props.notice.title}
                        body={props.notice.body}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
        </View>
    );
});
