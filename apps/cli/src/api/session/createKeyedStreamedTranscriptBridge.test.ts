import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';

type TranscriptCall = {
  provider: string;
  body: unknown;
  localId: string;
  meta: Record<string, unknown> | undefined;
};

function readMessageBody(call: TranscriptCall): { type?: unknown; message?: unknown; sidechainId?: unknown } {
  return call.body && typeof call.body === 'object' ? call.body : {};
}

async function settleSnapshots() {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createKeyedStreamedTranscriptBridge', () => {
  it('forwards live and durable cadence options into created writers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const durableCalls: TranscriptCall[] = [];
    const liveCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        liveCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      makeLocalId: ({ streamKey }) => `codex-stream:${streamKey}`,
      initialCheckpointDelayMs: 200,
      checkpointIntervalMs: 2_000,
      checkpointMinChars: 256,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'item-1', sidechainId: null, deltaText: 'Hello' });
    await settleSnapshots();

    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]?.localId).toBe('codex-stream:item-1');
    expect(durableCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await settleSnapshots();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'codex',
      body: { type: 'message', message: 'Hello' },
    });
  });

  it('flushes only matching stream scopes at tool-call boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'Root before' });
    await settleSnapshots();
    bridge.appendAssistantDelta({ streamKey: 'child:assistant:item-1', sidechainId: 'sc-1', deltaText: 'Child text' });
    await settleSnapshots();

    const initialRootLocalId = durableCalls.find((call) => readMessageBody(call).sidechainId === undefined)?.localId;
    expect(initialRootLocalId).toEqual(expect.any(String));

    await bridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === 'sc-1',
    });
    await settleSnapshots();

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: ' and after' });
    await settleSnapshots();

    const rootCalls = durableCalls.filter((call) => readMessageBody(call).sidechainId === undefined);
    const childCalls = durableCalls.filter((call) => readMessageBody(call).sidechainId === 'sc-1');

    expect(rootCalls.map((call) => call.localId)).toEqual([initialRootLocalId, initialRootLocalId]);
    expect(readMessageBody(rootCalls.at(-1)!).message).toBe('Root before and after');
    expect(childCalls.at(-1)?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('keeps appends that arrive while a matching stream is flushing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const firstCommitDrain = createDeferred<void>();
    let pendingFirstCommit = true;
    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
        if (pendingFirstCommit) {
          pendingFirstCommit = false;
          await firstCommitDrain.promise;
        }
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'Before boundary' });
    await settleSnapshots();

    const boundaryFlush = bridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === null,
    });
    await settleSnapshots();

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'After boundary' });
    await settleSnapshots();

    firstCommitDrain.resolve();
    await boundaryFlush;
    await bridge.flushAll({ reason: 'turn-end' });
    await settleSnapshots();

    const afterBoundaryCalls = durableCalls.filter((call) => readMessageBody(call).message === 'After boundary');
    expect(afterBoundaryCalls.length).toBeGreaterThan(0);
    expect(afterBoundaryCalls.at(-1)?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });
});
