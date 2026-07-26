import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, rename, rm, stat } from 'node:fs/promises';

import { expandHomeDirPath } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { resolveCodexCliInvocation } from '../../utils/resolveCodexCliInvocation';
import { appendCodexCliConfigOverridesArgs } from '../../utils/appendCodexCliConfigOverridesArgs';
import { resolveConfiguredCodexConfigTomlPath } from '../../utils/resolveConfiguredCodexHome';
import { createCodexAppServerJsonLineReader } from './codexAppServerJsonLineReader';
import { readCodexAppServerRequestTimeoutMs } from './codexAppServerRpcTimeout';
import {
    sanitizeCodexAppServerRpcDiagnosticString,
    sanitizeCodexAppServerRpcLogValue,
} from './codexAppServerRpcLogSanitizer';
import { safeJsonStringify } from '@/utils/safeJson';
import { createCodexAppServerRpcError } from '../appServerCompatibility';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import {
    createCodexAppServerProcessDisposalBoundary,
    disposeCodexAppServerProcess,
} from './disposeCodexAppServerProcess';

type JsonRpcMessage = Readonly<{
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string; data?: unknown }>;
}>;

type JsonRpcRequestHandler = (params: unknown, message: JsonRpcMessage) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerRequestOptions = Readonly<{
    timeoutMs?: number;
}>;

export type CodexAppServerClient = Readonly<{
    request: (method: string, params?: unknown, options?: CodexAppServerRequestOptions) => Promise<unknown>;
    notify: (method: string, params?: unknown) => Promise<void>;
    registerRequestHandler: (method: string, handler: JsonRpcRequestHandler) => () => void;
    registerNotificationHandler: (method: string, handler: JsonRpcNotificationHandler) => () => void;
}>;

export type CodexAppServerClientDisposeOptions = Readonly<{
    pendingRequestError?: Error;
}>;

export type CodexAppServerExitHandler = (error: Error) => void | Promise<void>;

export type DisposableCodexAppServerClient = CodexAppServerClient & Readonly<{
    onExit: (handler: CodexAppServerExitHandler) => () => void;
    dispose: (options?: CodexAppServerClientDisposeOptions) => Promise<void>;
}>;

type MessageQueueState = {
    fatalError: Error | null;
};

type PendingRequest = Readonly<{
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>;

export class CodexAppServerJsonLineTooLargeError extends Error {
    readonly maxChars: number;

    constructor(maxChars: number) {
        super(`Codex app-server JSON output exceeded ${maxChars} characters before newline; refusing to buffer it`);
        this.name = 'CodexAppServerJsonLineTooLargeError';
        this.maxChars = maxChars;
    }
}

export function isCodexAppServerJsonLineTooLargeError(error: unknown): error is CodexAppServerJsonLineTooLargeError {
    return error instanceof CodexAppServerJsonLineTooLargeError;
}

type RpcLogEntry = Readonly<{
    direction: 'incoming' | 'outgoing';
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string; data?: unknown }> | null;
}>;

const DEFAULT_RPC_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RPC_LOG_ROTATE_COUNT = 2;
const DEFAULT_MAX_JSON_LINE_CHARS = 128 * 1024 * 1024;

function resolveRpcLogPath(env: NodeJS.ProcessEnv): string | null {
    const raw = expandHomeDirPath(
        typeof env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH === 'string'
            ? env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH.trim()
            : '',
        env,
    );
    return raw ? raw : null;
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = typeof env[key] === 'string' ? env[key]?.trim() : '';
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRpcLogMaxBytes(env: NodeJS.ProcessEnv): number {
    return readPositiveIntegerEnv(env, 'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES', DEFAULT_RPC_LOG_MAX_BYTES);
}

function readRpcLogRotateCount(env: NodeJS.ProcessEnv): number {
    return Math.min(
        readPositiveIntegerEnv(env, 'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT', DEFAULT_RPC_LOG_ROTATE_COUNT),
        10,
    );
}

function readMaxJsonLineChars(env: NodeJS.ProcessEnv): number {
    return readPositiveIntegerEnv(
        env,
        'HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS',
        DEFAULT_MAX_JSON_LINE_CHARS,
    );
}

function sanitizeRpcLogError(error: RpcLogEntry['error']): RpcLogEntry['error'] {
    if (!error) return error;
    return {
        ...(typeof error.code === 'number' ? { code: error.code } : {}),
        ...(typeof error.message === 'string'
            ? { message: sanitizeCodexAppServerRpcDiagnosticString(error.message) }
            : {}),
        ...(error.data !== undefined ? { data: sanitizeCodexAppServerRpcLogValue(error.data) } : {}),
    };
}

async function rotateRpcLogIfNeeded(path: string, payload: string, maxBytes: number, rotateCount: number): Promise<void> {
    if (rotateCount <= 0) return;
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const current = await stat(path).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null;
        throw error;
    });
    if (!current || current.size + payloadBytes <= maxBytes) return;

    await rm(`${path}.${rotateCount}`, { force: true }).catch(() => undefined);
    for (let index = rotateCount - 1; index >= 1; index -= 1) {
        await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error: unknown) => {
            if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return;
            throw error;
        });
    }
    await rename(path, `${path}.1`).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return;
        throw error;
    });
}

function createRpcLogger(env: NodeJS.ProcessEnv): {
    append: (entry: RpcLogEntry) => void;
    flush: () => Promise<void>;
} {
    const path = resolveRpcLogPath(env);
    if (!path) {
        return { append: () => undefined, flush: async () => undefined };
    }

    const maxBytes = readRpcLogMaxBytes(env);
    const rotateCount = readRpcLogRotateCount(env);
    let chain = Promise.resolve();
    const append = (entry: RpcLogEntry): void => {
        const loggedEntry: RpcLogEntry = {
            ...entry,
            params: sanitizeCodexAppServerRpcLogValue(entry.params),
            result: sanitizeCodexAppServerRpcLogValue(entry.result),
            error: sanitizeRpcLogError(entry.error),
        };
        const payload = `${safeJsonStringify(loggedEntry)}\n`;
        chain = chain
            .then(async () => {
                await rotateRpcLogIfNeeded(path, payload, maxBytes, rotateCount);
                await appendFile(path, payload, { encoding: 'utf8' });
            })
            .catch(() => undefined);
    };

    return {
        append,
        flush: async () => {
            await chain;
        },
    };
}

function failWaiters(state: MessageQueueState, error: Error): void {
    if (state.fatalError === null) {
        state.fatalError = error;
    }
}

function createJsonRpcError(message: string, code = -32000): Readonly<{ code: number; message: string }> {
    return { code, message };
}

function toMessageKey(id: number | string | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return `${typeof id}:${String(id)}`;
}

function readJsonRpcIdFromLineStartSample(sample: string): number | string | null {
    const match = /"id"\s*:\s*(-?\d+|"((?:\\.|[^"\\])*)")/.exec(sample);
    if (!match) return null;
    const raw = match[1];
    if (!raw) return null;
    if (raw.startsWith('"')) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            return typeof parsed === 'string' ? parsed : null;
        } catch {
            return null;
        }
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function createDisposedError(): Error {
    return new Error('Codex app-server client has been disposed');
}

function resolveRequestTimeoutMs(defaultTimeoutMs: number, options?: CodexAppServerRequestOptions): number {
    if (options?.timeoutMs === undefined) {
        return defaultTimeoutMs;
    }
    const override = Math.trunc(options.timeoutMs);
    return Number.isFinite(override) && override > 0 ? Math.max(250, override) : defaultTimeoutMs;
}

function sanitizeCodexAppServerEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...processEnv,
        CODEX_THREAD_ID: undefined,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES: undefined,
        HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT: undefined,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
        [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
        [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
    };
}

function resolveCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
    return resolveConfiguredCodexConfigTomlPath(env);
}

function normalizeCodexMcpServerKeyFromConfigSection(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const firstChar = trimmed[0];
    if (firstChar === '"' || firstChar === "'") {
        const end = trimmed.indexOf(firstChar, 1);
        if (end === -1) return null;
        return trimmed.slice(0, end + 1);
    }

    const firstSegment = trimmed.split('.')[0]?.trim() ?? '';
    return firstSegment ? firstSegment : null;
}

function readCodexMcpServerKeysFromConfigToml(env: NodeJS.ProcessEnv): string[] {
    const configPath = resolveCodexConfigTomlPath(env);
    let text: string;
    try {
        text = readFileSync(configPath, 'utf8');
    } catch {
        return [];
    }

    const keys = new Set<string>();
    const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        const key = normalizeCodexMcpServerKeyFromConfigSection(match[1] ?? '');
        if (!key) continue;
        keys.add(key);
    }

    return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

export async function createCodexAppServerClient(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    configOverrides?: ReadonlyArray<string>;
    disableUserMcpServers?: boolean;
}>): Promise<DisposableCodexAppServerClient> {
    const sourceProcessEnv = params.processEnv ?? process.env;
    const rpcLogger = createRpcLogger(sourceProcessEnv);
    const processEnv = sanitizeCodexAppServerEnv(sourceProcessEnv);
    const baseInvocation = await resolveCodexCliInvocation({
        args: ['app-server', '--listen', 'stdio://'],
        cwd: params.cwd,
        processEnv,
        overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN', 'HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
        targetLabel: 'Codex app-server',
    });

    const baseOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(processEnv).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];

    const invocation = appendCodexCliConfigOverridesArgs(baseInvocation, [...baseOverrides, ...(params.configOverrides ?? [])]);
    const windowsInvocation = resolveWindowsCommandInvocation({
        command: invocation.command,
        args: invocation.args,
        resolveCommandOnPath: true,
    });
    const child = spawn(windowsInvocation.command, windowsInvocation.args, {
        cwd: params.cwd ?? process.cwd(),
        env: processEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: windowsInvocation.windowsVerbatimArguments,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error('Failed to start Codex app-server with piped stdio');
    }

    const state: MessageQueueState = {
        fatalError: null,
    };
    let stderrBuffer = '';
    const maxStderrChars = 8_000;
    const pendingRequests = new Map<string, PendingRequest>();
    const requestHandlers = new Map<string, JsonRpcRequestHandler>();
    const notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
    const exitHandlers = new Set<CodexAppServerExitHandler>();
    let writeChain = Promise.resolve();
    let nextId = 0;
    let disposing = false;
    let disposePromise: Promise<void> | null = null;
    let resolveClosed: (() => void) | null = null;
    const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const failPendingRequests = (error: Error): void => {
        for (const [requestKey, pending] of pendingRequests.entries()) {
            pendingRequests.delete(requestKey);
            pending.reject(error);
        }
    };

    const sendMessage = async (message: Record<string, unknown>): Promise<void> => {
        if (state.fatalError) {
            throw state.fatalError;
        }
        rpcLogger.append({
            direction: 'outgoing',
            id: (message as JsonRpcMessage).id ?? null,
            method: (message as JsonRpcMessage).method,
            params: (message as JsonRpcMessage).params ?? null,
            result: (message as JsonRpcMessage).result ?? null,
            error: ((message as JsonRpcMessage).error as RpcLogEntry['error']) ?? null,
        });
        let payload: string;
        try {
            payload = `${safeJsonStringify(message)}\n`;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const method = typeof message.method === 'string' ? message.method : 'notification';
            throw new Error(`Failed to serialize Codex app-server ${method} message: ${reason}`);
        }
        const nextWrite = writeChain.then(async () => {
            const stdin = child.stdin;
            if (!stdin || stdin.writableEnded || stdin.destroyed) {
                throw state.fatalError ?? createDisposedError();
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    stdin.write(payload, 'utf8', (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
        writeChain = nextWrite.catch(() => undefined);
        await nextWrite;
    };

    const handleServerRequest = async (message: JsonRpcMessage): Promise<void> => {
        if (typeof message.method !== 'string') return;
        const requestKey = toMessageKey(message.id);
        if (!requestKey) return;
        const handler = requestHandlers.get(message.method);
        if (!handler) {
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(`No handler registered for ${message.method}`, -32601),
            });
            return;
        }
        try {
            const result = await handler(message.params, message);
            await sendMessage({ id: message.id, result: result ?? null });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(failure.message),
            });
        }
    };

    const failWith = (error: unknown): void => {
        const failure = error instanceof Error ? error : new Error(String(error));
        failWaiters(state, failure);
        failPendingRequests(failure);
    };

    const handleIncomingMessage = (message: JsonRpcMessage): void => {
        rpcLogger.append({
            direction: 'incoming',
            id: message.id ?? null,
            method: message.method,
            params: message.params ?? null,
            result: message.result ?? null,
            error: message.error ?? null,
        });
        const requestKey = toMessageKey(message.id);
        if (typeof message.method === 'string') {
            if (requestKey) {
                void handleServerRequest(message).catch((error) => {
                    failWith(error);
                });
                return;
            }
            const handlers = notificationHandlers.get(message.method);
            if (handlers && handlers.size > 0) {
                for (const handler of [...handlers]) {
                    try {
                        const result = handler(message.params);
                        if (result && typeof (result as PromiseLike<void>).then === 'function') {
                            void Promise.resolve(result).catch((error: unknown) => {
                                failWith(error);
                            });
                        }
                    } catch (error) {
                        failWith(error);
                    }
                }
            }
            return;
        }
        if (!requestKey) {
            return;
        }
        const pending = pendingRequests.get(requestKey);
        if (!pending) {
            return;
        }
        pendingRequests.delete(requestKey);
        if (message.error) {
            pending.reject(createCodexAppServerRpcError({
                method: pending.method,
                code: message.error.code,
                message: message.error.message,
                data: message.error.data,
            }));
            return;
        }
        pending.resolve(message.result);
    };

    const handleOversizedJsonLine = (sample: string, maxBufferedChars: number): void => {
        const error = new CodexAppServerJsonLineTooLargeError(maxBufferedChars);
        const requestKey = toMessageKey(readJsonRpcIdFromLineStartSample(sample));
        if (requestKey) {
            const pending = pendingRequests.get(requestKey);
            if (pending) {
                pendingRequests.delete(requestKey);
                pending.reject(error);
                return;
            }
        }
        failWith(error);
    };

    const jsonLineReader = createCodexAppServerJsonLineReader(
        (rawLine) => {
            if (state.fatalError) return;
            try {
                handleIncomingMessage(JSON.parse(rawLine) as JsonRpcMessage);
            } catch (error) {
                failWith(new Error(`Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
        {
            maxBufferedChars: readMaxJsonLineChars(sourceProcessEnv),
            onOversizedLine: handleOversizedJsonLine,
        },
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        if (state.fatalError) return;
        try {
            jsonLineReader.push(chunk);
        } catch (error) {
            failWith(new Error(`Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`));
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        if (stderrBuffer.length >= maxStderrChars) return;
        stderrBuffer = (stderrBuffer + chunk).slice(0, maxStderrChars);
    });
    child.once('error', (error) => {
        failWith(new Error(`Failed to launch Codex app-server: ${error.message}`));
    });
    child.once('close', (code, signal) => {
        resolveClosed?.();
        if (disposing) {
            return;
        }
        const suffix = stderrBuffer.trim()
            ? `\n${sanitizeCodexAppServerRpcDiagnosticString(stderrBuffer.trim())}`
            : '';
        const failure = new Error(`Codex app-server exited before completing the request (code=${code ?? 'null'} signal=${signal ?? 'null'})${suffix}`);
        failWith(failure);
        for (const handler of [...exitHandlers]) {
            void Promise.resolve(handler(failure)).catch(() => undefined);
        }
    });

    const request = async (
        method: string,
        requestParams?: unknown,
        requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
        const timeoutMs = resolveRequestTimeoutMs(
            readCodexAppServerRequestTimeoutMs(method, processEnv),
            requestOptions,
        );
        const id = ++nextId;
        const requestKey = toMessageKey(id);
        if (!requestKey) {
            throw new Error(`Failed to create Codex app-server request id for ${method}`);
        }
        const responsePromise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(requestKey);
                reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pendingRequests.set(requestKey, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
        try {
            await sendMessage({
                id,
                method,
                // Codex app-server rejects requests that omit the `params` field entirely.
                params: requestParams === undefined ? {} : requestParams,
            });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            const pending = pendingRequests.get(requestKey);
            pendingRequests.delete(requestKey);
            pending?.reject(failure);
        }
        return await responsePromise;
    };

    const notify = async (method: string, notificationParams?: unknown): Promise<void> => {
        await sendMessage({
            method,
            // Codex app-server rejects notifications that omit the `params` field entirely.
            params: notificationParams === undefined ? {} : notificationParams,
        });
    };

    const registerRequestHandler = (method: string, handler: JsonRpcRequestHandler): (() => void) => {
        requestHandlers.set(method, handler);
        return () => {
            if (requestHandlers.get(method) === handler) {
                requestHandlers.delete(method);
            }
        };
    };

    const registerNotificationHandler = (method: string, handler: JsonRpcNotificationHandler): (() => void) => {
        const existing = notificationHandlers.get(method);
        if (existing) {
            existing.add(handler);
        } else {
            notificationHandlers.set(method, new Set([handler]));
        }
        return () => {
            const handlers = notificationHandlers.get(method);
            if (!handlers) return;
            handlers.delete(handler);
            if (handlers.size === 0) {
                notificationHandlers.delete(method);
            }
        };
    };

    const dispose = async (options?: CodexAppServerClientDisposeOptions): Promise<void> => {
        if (disposePromise) {
            return await disposePromise;
        }
        disposing = true;
        const disposedError = options?.pendingRequestError ?? createDisposedError();
        failWaiters(state, disposedError);
        failPendingRequests(disposedError);
        disposePromise = (async () => {
            await disposeCodexAppServerProcess(
                createCodexAppServerProcessDisposalBoundary({ child, closedPromise }),
                {
                    gracefulTimeoutMs: 2_000,
                    forceTimeoutMs: 1_000,
                },
            );
            await rpcLogger.flush().catch(() => undefined);
        })();
        return await disposePromise;
    };

    const onExit = (handler: CodexAppServerExitHandler): (() => void) => {
        exitHandlers.add(handler);
        return () => {
            exitHandlers.delete(handler);
        };
    };

    try {
        await request('initialize', {
            clientInfo: {
                name: 'happier_cli',
                title: 'Happier',
                version: '0.1.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        await notify('initialized');

        return { request, notify, registerRequestHandler, registerNotificationHandler, onExit, dispose };
    } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
    }
}
