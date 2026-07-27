import { afterEach, describe, expect, it, vi } from 'vitest';

describe('waitForSessionIdle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    function mockTransportContext(rawSession: Record<string, unknown>) {
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: '{"requests":{"stale":{"createdAt":1}}}',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    ...rawSession,
                },
            })),
        }));
    }

    function credentials() {
        const machineKey = new Uint8Array(32).fill(1);
        return {
            token: 'token',
            encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
        };
    }

    it('seeds socket idle wait from a busy projection without transcript scan', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 123 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'in_progress',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            idle: true,
            observedAt: 123,
        });

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: true,
                turnInFlight: true,
            },
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('checks transcript activity for an idle projection and lets transcript-busy win', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            },
            {
                id: 'm2',
                seq: 2,
                createdAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_started', id: 'task-1' },
                        },
                    },
                },
            },
        ]);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 123 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'completed',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            idle: true,
        }));

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token',
            sessionId: 'sess-1',
            limit: 20,
            timeoutMs: expect.any(Number),
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: true,
                turnInFlight: true,
            },
            initialTurnActivityRequiresTranscriptIdleEvidence: true,
        }));
    });

    it('treats transcript fetch failure for an idle projection as unable to prove idle', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => {
            throw new Error('transcript unavailable');
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async (request: Readonly<{
            initialTurnActivity?: Readonly<{ turnInFlight?: boolean }>;
            initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
        }>) => {
            if (
                request.initialTurnActivity?.turnInFlight === false
                && request.initialTurnActivityRequiresTranscriptIdleEvidence !== true
            ) {
                return { idle: true as const, observedAt: 123 };
            }
            throw new Error('timeout');
        });

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'completed',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: expect.objectContaining({
                turnInFlight: true,
            }),
            initialTurnActivityRequiresTranscriptIdleEvidence: true,
        }));
    });

    it('spends transcript scan time from the caller budget while the shared socket keeps an independent lifetime', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async (_params: Readonly<{ timeoutMs?: number }>) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return [];
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async (_params: Readonly<{
            timeoutMs?: number;
            signal?: AbortSignal;
        }>) => ({
            idle: true as const,
            observedAt: 123,
        }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'completed',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 100,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            idle: true,
        }));

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledWith(expect.objectContaining({
            timeoutMs: expect.any(Number),
        }));
        const transcriptCall = fetchEncryptedTranscriptPageLatest.mock.calls[0]?.[0];
        const transcriptTimeoutMs = transcriptCall?.timeoutMs;
        expect(transcriptTimeoutMs).toBeGreaterThan(0);
        expect(transcriptTimeoutMs).toBeLessThanOrEqual(100);
        const socketCall = waitForIdleViaSocket.mock.calls[0]?.[0];
        const socketTimeoutMs = socketCall?.timeoutMs;
        expect(socketTimeoutMs).toBe(60 * 60_000);
        expect(socketCall?.signal).toBeInstanceOf(AbortSignal);
    });

    it('shares one canonical idle observation stream across concurrent waiters', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const idleDeferred: {
            resolve?: (value: { idle: true; observedAt: number }) => void;
        } = {};
        const waitForIdleViaSocket = vi.fn(() => new Promise<{ idle: true; observedAt: number }>((resolve) => {
            idleDeferred.resolve = resolve;
        }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'in_progress',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');
        const waits = Array.from({ length: 3 }, () => waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        }));

        await vi.waitFor(() => {
            expect(waitForIdleViaSocket).toHaveBeenCalled();
        });
        expect(waitForIdleViaSocket).toHaveBeenCalledOnce();

        const resolveIdle = idleDeferred.resolve;
        if (!resolveIdle) {
            throw new Error('Shared idle observation did not start');
        }
        resolveIdle({ idle: true, observedAt: 456 });

        await expect(Promise.all(waits)).resolves.toEqual([
            { ok: true, sessionId: 'sess-1', idle: true, observedAt: 456 },
            { ok: true, sessionId: 'sess-1', idle: true, observedAt: 456 },
            { ok: true, sessionId: 'sess-1', idle: true, observedAt: 456 },
        ]);
    });

    it('aborts the shared observation when the last waiter reaches its own deadline', async () => {
        vi.useFakeTimers();
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        let sharedSignal: AbortSignal | undefined;
        const waitForIdleViaSocket = vi.fn((input: Readonly<{ signal?: AbortSignal }>) => {
            sharedSignal = input.signal;
            return new Promise<{ idle: true; observedAt: number }>(() => undefined);
        });

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'in_progress',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');
        const wait = waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 20,
        });

        await vi.waitFor(() => {
            expect(waitForIdleViaSocket).toHaveBeenCalledOnce();
        });
        await vi.advanceTimersByTimeAsync(25);

        await expect(wait).resolves.toEqual({ ok: false, code: 'timeout' });
        expect(sharedSignal?.aborted).toBe(true);
    });
});
