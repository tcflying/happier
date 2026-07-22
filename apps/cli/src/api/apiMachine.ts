/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { registerWorkspaceAnchorHandlers } from '@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers';
import { registerWorkspaceFaviconHandlers } from '@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type {
    DirectSessionTranscriptDeltaEphemeral,
    MachineTransferReceiveEnvelope,
    MachineTransferSendEnvelope,
} from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { readLastChangesCursor, writeLastChangesCursor } from '@/persistence';
import { resolveLoopbackHttpUrl } from './client/loopbackUrl';
import { createAuthenticationHttpStatusError, isAuthenticationError, isAuthenticationStatus } from './client/httpStatusError';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    createSessionMutationOutbox,
    type SessionMutationOutbox,
    type SessionMutationSocket,
} from './session/mutations/createSessionMutationOutbox';
import { createSessionEndMutation, createSessionTurnMutation } from './session/mutations/sessionMutationTypes';
import type { DirectSessionFollowLeaseManager } from './directSessions/leases/createDirectSessionFollowLeaseManager';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { registerMachineRpcHandlers, type MachineRpcHandlerDeps, type MachineRpcHandlers } from './machine/rpcHandlers';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';

export type ApiMachineClientDeps = Readonly<{
    connectedAccounts?: ScmConnectedAccountCredentialResolver;
}>;

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

export type AccountSettingsVersionHintNotification = Readonly<{
    settingsVersion: number | null;
    source: AccountSettingsVersionHintSource;
}>;

type MachineSessionEndPayload = Readonly<{
    sid: string;
    time: number;
    exit?: unknown;
}>;

function isMachineSessionEndPayload(value: unknown): value is MachineSessionEndPayload {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as { sid?: unknown; time?: unknown };
    return typeof candidate.sid === 'string' && typeof candidate.time === 'number';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readSocketConnectErrorDiagnostic(error: unknown): Record<string, unknown> {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const details: Record<string, unknown> = {
        message: error instanceof Error ? error.message : typeof record?.message === 'string' ? record.message : String(error),
    };

    if (typeof record?.name === 'string' && record.name.trim().length > 0) {
        details.name = record.name;
    }
    if (typeof record?.code === 'string' && record.code.trim().length > 0) {
        details.code = record.code;
    }

    const statusCode = typeof record?.statusCode === 'number'
        ? record.statusCode
        : typeof data?.statusCode === 'number'
            ? data.statusCode
            : null;
    if (statusCode !== null) {
        details.statusCode = statusCode;
    }

    return details;
}

function isMachineReplacedSocketError(error: unknown, diagnostic: Record<string, unknown>): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = data?.error ?? record?.message;
    return diagnostic.statusCode === 410 && errorCode === 'machine-replaced';
}

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private changesSyncInFlight: Promise<void> | null = null;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private accountSettingsVersionHintListeners = new Set<(hint: AccountSettingsVersionHintNotification) => void | Promise<void>>();
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private sessionEndMutationOutboxes = new Map<string, SessionMutationOutbox>();
    private directSessionFollowLeaseManager: DirectSessionFollowLeaseManager | null = null;
    private readonly machineRpcWorkingDirectory: string;
    private readonly filesystemAccessPolicy: FilesystemAccessPolicy;
    private readonly ownershipMetadata: Readonly<{
        runtimeId?: string;
        cliVersion?: string;
        publicReleaseChannel?: string;
        startupSource?: string;
        serviceManaged?: boolean;
        serviceLabel?: string;
    }>;
    private activeTransportGeneration = 0;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };

    private teardownActiveSocket(): void {
        if (!this.socket) {
            return;
        }
        this.rpcHandlerManager.onSocketDisconnect();
        this.stopKeepAlive();
        this.socket = null;
    }

    private isCurrentConnectionState(state: ManagedConnectionState): boolean {
        return this.currentConnectionState.phase === state.phase
            && this.currentConnectionState.reason === state.reason
            && this.currentConnectionState.attempt === state.attempt
            && this.currentConnectionState.nextRetryAt === state.nextRetryAt
            && this.currentConnectionState.lastConnectedAt === state.lastConnectedAt
            && this.currentConnectionState.lastDisconnectedAt === state.lastDisconnectedAt
            && this.currentConnectionState.lastErrorMessage === state.lastErrorMessage;
    }

    private isActiveTransportGeneration(generation: number): boolean {
        return generation === this.activeTransportGeneration;
    }

    private handleTransportSocketDisconnect(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number): void {
        logger.debug('[API MACHINE] Disconnected from server');
        if (!this.isActiveTransportGeneration(generation) || this.socket !== socket) {
            return;
        }
        this.teardownActiveSocket();
    }

    constructor(
        private token: string,
        private machine: Machine,
        ownershipMetadata?: Readonly<{
            runtimeId?: string;
            cliVersion?: string;
            publicReleaseChannel?: string;
            startupSource?: string;
            serviceManaged?: boolean;
            serviceLabel?: string;
        }>,
        deps?: ApiMachineClientDeps,
    ) {
        this.ownershipMetadata = ownershipMetadata ?? {};
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        const machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        const filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        this.machineRpcWorkingDirectory = machineRpcWorkingDirectory;
        this.filesystemAccessPolicy = filesystemAccessPolicy;
        let additionalAllowedReadDirs: string[] = [];
        let additionalAllowedWriteDirs: string[] = [];
        registerSessionHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            setAdditionalAllowedReadDirs: (dirs) => {
                additionalAllowedReadDirs = dirs;
            },
            setAdditionalAllowedWriteDirs: (dirs) => {
                additionalAllowedWriteDirs = dirs;
            },
        });
        registerFileSystemHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => additionalAllowedReadDirs,
            getAdditionalAllowedWriteDirs: () => additionalAllowedWriteDirs,
        });
        registerWorkspaceAnchorHandlers(this.rpcHandlerManager, {
            defaultDirectory: machineRpcWorkingDirectory,
            accessPolicy: filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(this.rpcHandlerManager, {
            defaultDirectory: machineRpcWorkingDirectory,
            accessPolicy: filesystemAccessPolicy,
        });
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            accessPolicy: filesystemAccessPolicy,
        });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            connectedAccounts: deps?.connectedAccounts,
        });
    }

    setRPCHandlers({
        spawnSession,
        resolveSpawnSessionByNonce,
        stopSession,
        isSessionActive,
        loadLocalSessionMetadata,
        requestShutdown,
        memory,
        daemonServerWorkScheduler,
        machineTransferChannel,
        directPeerTransfer,
    }: MachineRpcHandlers, deps?: MachineRpcHandlerDeps) {
        registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                ...(loadLocalSessionMetadata ? { loadLocalSessionMetadata } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(daemonServerWorkScheduler ? { daemonServerWorkScheduler } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
            },
            deps: {
                ...deps,
                machineRpcWorkingDirectory: this.machineRpcWorkingDirectory,
                filesystemAccessPolicy: this.filesystemAccessPolicy,
                emitDirectSessionTranscriptUpdate:
                    deps?.emitDirectSessionTranscriptUpdate
                    ?? ((payload) => this.emitDirectSessionTranscriptUpdate(payload)),
                onDirectSessionFollowLeaseManagerReady: (manager) => {
                    this.directSessionFollowLeaseManager = manager;
                    deps?.onDirectSessionFollowLeaseManagerReady?.(manager);
                },
            },
        });
    }

    async releaseDirectSessionRuntimeOwnership(sessionId: string): Promise<void> {
        await this.directSessionFollowLeaseManager?.setRuntimeOwned(sessionId, false);
    }

    async claimDirectSessionRuntimeOwnership(sessionId: string): Promise<void> {
        await this.directSessionFollowLeaseManager?.setRuntimeOwned(sessionId, true);
    }

    onUpdate(listener: (update: Update) => boolean | void): () => void {
        this.updateListeners.add(listener);
        return () => {
            this.updateListeners.delete(listener);
        };
    }

    onAccountSettingsVersionHint(listener: (hint: AccountSettingsVersionHintNotification) => void | Promise<void>): () => void {
        this.accountSettingsVersionHintListeners.add(listener);
        return () => {
            this.accountSettingsVersionHintListeners.delete(listener);
        };
    }

    private async notifyAccountSettingsVersionHint(hint: AccountSettingsVersionHintNotification): Promise<void> {
        for (const listener of this.accountSettingsVersionHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Account settings version hint listener failed; continuing changes catch-up', {
                    settingsVersion: hint.settingsVersion,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    onMachineTransferEnvelope(listener: (payload: MachineTransferReceiveEnvelope) => void): () => void {
        this.machineTransferListeners.add(listener);
        return () => {
            this.machineTransferListeners.delete(listener);
        };
    }

    onConnectionStateChange(listener: (state: ManagedConnectionState) => void): () => void {
        this.connectionStateListeners.add(listener);
        listener(this.currentConnectionState);
        return () => {
            this.connectionStateListeners.delete(listener);
        };
    }

    sendMachineTransferEnvelope(payload: MachineTransferSendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, payload);
    }

    emitDirectSessionTranscriptUpdate(payload: DirectSessionTranscriptDeltaEphemeral): void {
        if (!this.socket) return;
        this.socket.emit('direct-session-transcript-delta', payload);
    }

    private dispatchUpdate(update: Update): boolean {
        let handled = false;
        for (const listener of this.updateListeners) {
            try {
                if (listener(update) === true) {
                    handled = true;
                }
            } catch (error) {
                logger.warn('[API MACHINE] Update listener threw (ignored)', {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return handled;
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.metadata);

            // No-op: don't write if nothing changed.
            if (this.machine.metadata && JSON.stringify(updated) === JSON.stringify(this.machine.metadata)) {
                return;
            }

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-metadata',
                payload: {
                    machineId: this.machine.id,
                    metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                    expectedVersion: this.machine.metadataVersion
                },
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.daemonState);

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-state',
                payload: {
                    machineId: this.machine.id,
                    daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                    expectedVersion: this.machine.daemonStateVersion
                },
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    private async confirmSessionEndOverHttp(payload: MachineSessionEndPayload): Promise<'confirmed' | 'unsupported'> {
        const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
        const response = await axios.post(
            `${serverUrl}/v1/sessions/${encodeURIComponent(payload.sid)}/end`,
            { time: payload.time },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15_000,
                validateStatus: () => true,
            },
        );
        if (isAuthenticationStatus(response.status)) {
            throw createAuthenticationHttpStatusError(
                response.status,
                `Authentication failed while confirming session end (${response.status})`,
            );
        }
        if (response.status === 404 || response.status === 405 || response.status === 501) {
            return 'unsupported';
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Session-end HTTP confirmation failed with status ${response.status}`);
        }
        return 'confirmed';
    }

    emitSessionEnd(payload: MachineSessionEndPayload) {
        // Socket fanout is kept for compatibility; HTTP is the durable confirmation path.
        const emittedLegacySessionEnd = Boolean(this.socket);
        if (this.socket) {
            this.socket.emit('session-end', payload);
        }
        void this.confirmSessionEndOverHttp(payload).then((result) => {
            if (result === 'unsupported' && emittedLegacySessionEnd) return;
            if (result === 'unsupported') {
                logger.warn('[API MACHINE] Failed to confirm session-end over HTTP', {
                    error: { message: 'Session-end HTTP confirmation route unsupported' },
                });
            }
        }).catch((error) => {
            logger.warn('[API MACHINE] Failed to confirm session-end over HTTP', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private createSessionEndMutationSocket(): SessionMutationSocket {
        return {
            connected: this.socket?.connected === true,
            emit: (event: string, payload: unknown) => {
                if (event !== 'session-end' || !this.socket || !isMachineSessionEndPayload(payload)) {
                    return;
                }
                this.socket.emit('session-end', payload);
            },
            emitWithAck: async () => {
                throw new Error('Machine session-end mutation outbox does not support ack-based events');
            },
        };
    }

    private getSessionEndMutationOutbox(sessionId: string): SessionMutationOutbox {
        const existing = this.sessionEndMutationOutboxes.get(sessionId);
        if (existing) return existing;

        const outbox = createSessionMutationOutbox({
            token: this.token,
            sessionId,
            getSocket: () => this.createSessionEndMutationSocket(),
            requestReconnect: () => {},
        });
        this.sessionEndMutationOutboxes.set(sessionId, outbox);
        return outbox;
    }

    enqueueSessionEndMutation(payload: MachineSessionEndPayload): void {
        const sessionId = payload.sid.trim();
        if (!sessionId) {
            return;
        }

        void this.getSessionEndMutationOutbox(sessionId).enqueueSessionEnd(createSessionEndMutation({
            sessionId,
            observedAt: payload.time,
            ...(payload.exit !== undefined ? { exit: payload.exit } : {}),
        })).catch((error) => {
            logger.warn('[API MACHINE] Failed to enqueue durable session-end mutation', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    /**
     * Durable daemon-side settlement of a dead runner's open canonical turn (Lane N1). Delivered
     * as an `end_session` turn mutation through the per-session mutation outbox; the machine
     * socket has no turn-mutation event, so delivery uses the HTTP turn route. The server no-ops
     * when no turn is open or the open turn began after `time` (a replacement runner's turn).
     */
    enqueueSessionTurnSettlementMutation(payload: Readonly<{ sid: string; time: number }>): void {
        const sessionId = payload.sid.trim();
        if (!sessionId) {
            return;
        }

        void this.getSessionEndMutationOutbox(sessionId).enqueueSessionTurn(createSessionTurnMutation({
            sessionId,
            action: 'end_session',
            mutationId: `daemon-exit-turn-settlement:${sessionId}:${payload.time}`,
            observedAt: payload.time,
        })).catch((error) => {
            logger.warn('[API MACHINE] Failed to enqueue durable session turn settlement mutation', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    connect(params?: {
        takeover?: boolean;
        onConnect?: () => void | Promise<void>;
        onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
        onMachineReplaced?: () => void;
    }) {
        const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                createTransport: () => {
                    const transportGeneration = this.activeTransportGeneration + 1;
                    this.activeTransportGeneration = transportGeneration;
                    const installationIdentity = readInstallationIdentityIfExistsSync();
                    const installationProof = installationIdentity
                        ? buildInstallationProofForMachine({
                            identity: installationIdentity,
                            machineId: this.machine.id,
                            token: this.token,
                        })
                        : null;
                    const { socket, transport } = createMachineSocketTransport({
                        serverUrl,
                        token: this.token,
                        machineId: this.machine.id,
                        ...(installationProof
                            ? {
                                installationId: installationProof.installationId,
                                installationPublicKey: installationProof.installationPublicKey,
                                installationProof: installationProof.installationProof,
                            }
                            : null),
                        ...this.ownershipMetadata,
                        takeover: takeoverOnNextConnect,
                        transports: configuration.socketIoTransports,
                        env: process.env,
                    });
                    this.socket = socket;
                    this.installSocketEventHandlers(socket, transportGeneration, params);
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket, transportGeneration);
                    });
                    return transport;
                },
                probeReadiness: createLoopbackReadinessProbe({
                    serverUrl: configuration.apiServerUrl,
                    token: this.token,
                }),
                onStateChange: (state) => {
                    this.currentConnectionState = state;
                    for (const listener of this.connectionStateListeners) {
                        listener(state);
                    }
                },
                onConnected: async () => {
                    logger.debug('[API MACHINE] Connected to server');
                    const isReconnect = this.hasConnectedOnce;
                    this.hasConnectedOnce = true;
                    takeoverOnNextConnect = false;

                    if (this.socket) {
                        this.rpcHandlerManager.onSocketConnect(this.socket);
                    }

                    void this.updateDaemonState((state) => ({
                        ...state,
                        status: 'running',
                        pid: process.pid,
                        httpPort: this.machine.daemonState?.httpPort,
                        startedAt: Date.now()
                    })).catch((error) => {
                        logger.warn('[API MACHINE] Failed to update daemon state on connect', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });

                    void this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' }).catch((error) => {
                        logger.warn('[API MACHINE] /v2/changes sync failed', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                    this.startKeepAlive();

                    if (params?.onConnect) {
                        await Promise.resolve(params.onConnect()).catch(() => {});
                    }
                },
                onDisconnected: async () => {
                    // The transport socket that actually disconnected owns teardown via its
                    // socket-scoped disconnect handler. This avoids stale callbacks from an
                    // older transport clearing a newer active socket.
                },
                onAuthFailed: async (ctx) => {
                    logger.debug('[API MACHINE] Auth failed');
                    if (!this.isCurrentConnectionState(ctx.state)) {
                        return;
                    }
                    this.teardownActiveSocket();
                },
            });
        }

        void this.connectionSupervisor.start().catch((error) => {
            logger.warn('[API MACHINE] Failed to start machine connection supervisor', {
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    private installSocketEventHandlers(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
        params?: {
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: () => void;
        },
    ) {
        socket.on('connect_error', (error: unknown) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const ownershipConflict = readMachineOwnerConflictFromSocketError(error);
            if (!ownershipConflict) {
                const diagnostic = readSocketConnectErrorDiagnostic(error);
                logger.warn('[API MACHINE] Machine socket connect error', diagnostic);
                if (isMachineReplacedSocketError(error, diagnostic)) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.();
                }
                return;
            }
            void this.connectionSupervisor?.stop().catch(() => {});
            params?.onOwnershipConflict?.(ownershipConflict);
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        socket.on(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, (data: MachineTransferReceiveEnvelope) => {
            for (const listener of this.machineTransferListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine transfer listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on('update', (data: Update) => {
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
                return;
            }

            const handled = this.dispatchUpdate(data);
            if (!handled && process.env.DEBUG) {
                logger.debug(`[API MACHINE] Ignored update type: ${(data.body as any).t}`);
            }
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            if (!this.socket) {
                return;
            }
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    async shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        this.socket = null;
        if (this.connectionSupervisor) {
            await this.connectionSupervisor.stop();
        }
        const outboxes = Array.from(this.sessionEndMutationOutboxes.values());
        this.sessionEndMutationOutboxes.clear();
        await Promise.all(outboxes.map(async (outbox) => {
            try {
                await outbox.close();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to close session-end mutation outbox', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    async awaitPendingRpcRequests(): Promise<void> {
        await this.rpcHandlerManager.waitForIdle();
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            return await this.accountIdPromise.catch((error) => {
                if (isAuthenticationError(error)) {
                    if (this.connectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            });
        }

        const request = () => fetchChangesAccountId({ token: this.token });
        const supervisor = this.connectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async refreshMachineFromServer(): Promise<void> {
        try {
            const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
            const request = async () => {
                const response = await axios.get(`${serverUrl}/v1/machines/${this.machine.id}`, {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15_000,
                    validateStatus: () => true,
                });
                if (isAuthenticationStatus(response.status)) {
                    throw createAuthenticationHttpStatusError(
                        response.status,
                        `Authentication failed while refreshing machine snapshot (${response.status})`,
                    );
                }
                return response;
            };
            const response = this.connectionSupervisor
                ? await runSupervisedRequest({
                    supervisor: this.connectionSupervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                    readStatusCode: (result) => result.status,
                })
                : await request();

            if (response.status !== 200) {
                return;
            }

            const raw = (response.data as any)?.machine;
            if (!raw || typeof raw !== 'object') {
                return;
            }

            const nextMetadata =
                typeof raw.metadata === 'string'
                    ? decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(raw.metadata))
                    : null;
            const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : this.machine.metadataVersion;

            const nextDaemonState =
                typeof raw.daemonState === 'string'
                    ? decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(raw.daemonState))
                    : null;
            const nextDaemonStateVersion = typeof raw.daemonStateVersion === 'number' ? raw.daemonStateVersion : this.machine.daemonStateVersion;

            if (nextMetadataVersion > this.machine.metadataVersion) {
                this.machine.metadata = nextMetadata;
                this.machine.metadataVersion = nextMetadataVersion;
            }
            if (nextDaemonStateVersion > this.machine.daemonStateVersion) {
                this.machine.daemonState = nextDaemonState;
                this.machine.daemonStateVersion = nextDaemonStateVersion;
            }
        } catch (error) {
            logger.debug('[API MACHINE] Failed to refresh machine snapshot', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private async syncChangesOnConnect(opts: { reason: 'connect' | 'reconnect' }): Promise<void> {
        const enabled = (() => {
            const raw = process.env.HAPPY_ENABLE_V2_CHANGES;
            if (!raw) return true;
            return ['true', '1', 'yes'].includes(raw.toLowerCase());
        })();
        if (!enabled) {
            return;
        }

        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
        }

        const p = (async () => {
            const accountId = await this.getAccountId();
            if (!accountId) return;

            const CHANGES_PAGE_LIMIT = 200;
            const after = await readLastChangesCursor(accountId);
            const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT });

            if (result.status === 'cursor-gone') {
                await this.refreshMachineFromServer();
                await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
                await writeLastChangesCursor(accountId, result.currentCursor);
                return;
            }
            if (result.status !== 'ok') {
                if (handleRequestAuthenticationFailure({
                    supervisor: this.connectionSupervisor,
                    error: result.error,
                    hadAuth: true,
                })) {
                    return;
                }

                // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
                // On reconnect, fall back to a snapshot refresh.
                if (opts.reason === 'reconnect') {
                    await this.refreshMachineFromServer();
                }
                return;
            }

            const changes = result.response.changes;
            const nextCursor = result.response.nextCursor;

            const hasRelevantMachineChange = changes.some(
                (c) => c.kind === 'machine' && c.entityId === this.machine.id,
            );
            const accountSettingsVersions = changes
                .filter((c) => c.kind === 'account' && c.entityId === 'self')
                .map((c) => readAccountSettingsVersionFromHint(c.hint))
                .filter((version): version is number => version !== null);
            const highestAccountSettingsVersion = accountSettingsVersions.length > 0
                ? Math.max(...accountSettingsVersions)
                : null;

            if (changes.length >= CHANGES_PAGE_LIMIT || hasRelevantMachineChange) {
                await this.refreshMachineFromServer();
            }
            if (highestAccountSettingsVersion !== null) {
                await this.notifyAccountSettingsVersionHint({
                    settingsVersion: highestAccountSettingsVersion,
                    source: 'changes',
                });
            } else if (changes.length >= CHANGES_PAGE_LIMIT) {
                await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'page-limit' });
            }

            await writeLastChangesCursor(accountId, nextCursor);
        })();

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            this.changesSyncInFlight = null;
        }
    }
}
