import { stat } from 'node:fs/promises';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';
import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { collectCodexDirectTranscriptRolloutStreams } from './collectCodexDirectTranscriptRolloutStreams';
import {
  decodeCodexDirectBackwardCursor,
  encodeCodexDirectBackwardCursor,
} from './codexDirectTranscriptBackwardCursor';
import {
  decodeCodexDirectForwardCursor,
  encodeCodexDirectForwardCursor,
  type CodexDirectForwardCursor,
} from './codexDirectForwardCursor';
import {
  compareCodexProjectedRecordsOldestFirst,
  measureDirectTranscriptItemBytes,
  projectCodexRolloutLineToTranscriptRecords,
  type CodexDirectTranscriptRolloutStream,
  type CodexProjectedTranscriptRecord,
  type CodexStreamProgress,
} from './codexDirectTranscriptProjection';

async function statFileSize(filePath: string): Promise<number> {
  return stat(filePath).then((s) => Math.max(0, Math.trunc(s.size))).catch(() => 0);
}

function normalizeOffsetBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function buildStreamVectorCursorFromProgress(
  streams: readonly CodexDirectTranscriptRolloutStream[],
  progressByStreamId: ReadonlyMap<string, CodexStreamProgress>,
): string {
  return encodeCodexDirectForwardCursor({
    v: 4,
    kind: 'codexForwardStreamVector',
    streams: streams
      .map((stream) => {
        const progress = progressByStreamId.get(stream.fileRelPath);
        return {
          fileRelPath: stream.fileRelPath,
          nextOffsetBytes: progress?.nextOffsetBytes ?? 0,
          subIndex: progress?.subIndex ?? 0,
        };
      })
      .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
  });
}

async function buildCodexStreamVectorTailCursor(
  streams: readonly CodexDirectTranscriptRolloutStream[],
): Promise<string> {
  const progressEntries = await Promise.all(streams.map(async (stream) => [
    stream.fileRelPath,
    { nextOffsetBytes: await statFileSize(stream.filePath), subIndex: 0 },
  ] as const));
  return buildStreamVectorCursorFromProgress(streams, new Map(progressEntries));
}

function decodeStreamVectorCursor(cursor: CodexDirectForwardCursor | null): ReadonlyMap<string, CodexStreamProgress> | null {
  if (!cursor || cursor.kind !== 'codexForwardStreamVector') return null;
  return new Map(
    cursor.streams.map((entry) => [
      entry.fileRelPath,
      {
        nextOffsetBytes: Math.max(0, Math.trunc(entry.nextOffsetBytes)),
        subIndex: Math.max(0, Math.trunc(entry.subIndex ?? 0)),
      },
    ]),
  );
}

async function collectReadAfterRecords(params: Readonly<{
  codexHome: string;
  initialStreams: readonly CodexDirectTranscriptRolloutStream[];
  initialProgressByStreamId: ReadonlyMap<string, CodexStreamProgress>;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  streams: readonly CodexDirectTranscriptRolloutStream[];
  records: readonly CodexProjectedTranscriptRecord[];
  baseProgressByStreamId: ReadonlyMap<string, CodexStreamProgress>;
}>> {
  const streamsById = new Map(params.initialStreams.map((stream) => [stream.fileRelPath, stream] as const));
  const streamQueue = [...params.initialStreams];
  const records: CodexProjectedTranscriptRecord[] = [];
  const baseProgressByStreamId = new Map(params.initialProgressByStreamId);
  const semanticTrackerByStreamId = new Map<string, ReturnType<typeof createCodexRolloutSemanticTracker>>();
  const seenThreadIds = new Set(params.initialStreams.map((stream) => stream.threadId));

  for (let queueIndex = 0; queueIndex < streamQueue.length; queueIndex += 1) {
    const stream = streamQueue[queueIndex]!;
    const fileSize = await statFileSize(stream.filePath);
    const progress = params.initialProgressByStreamId.get(stream.fileRelPath) ?? { nextOffsetBytes: 0, subIndex: 0 };
    const offsetBytes = Math.min(fileSize, normalizeOffsetBytes(progress.nextOffsetBytes));
    if (offsetBytes >= fileSize) continue;

    const semanticTracker = semanticTrackerByStreamId.get(stream.fileRelPath) ?? createCodexRolloutSemanticTracker();
    semanticTrackerByStreamId.set(stream.fileRelPath, semanticTracker);
    const page = await readJsonlFileForward({
      filePath: stream.filePath,
      offsetBytes,
      maxBytes: Math.max(params.maxBytes, 1),
      maxItems: Math.max(params.maxItems * 2, 1),
    });

    for (const line of page.items) {
      const projected = projectCodexRolloutLineToTranscriptRecords({
        codexHome: params.codexHome,
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineNextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.records.length === 0) {
        baseProgressByStreamId.set(stream.fileRelPath, {
          nextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
          subIndex: 0,
        });
      }
      for (const record of projected.records) {
        if (record.lineStartOffsetBytes === offsetBytes && record.subIndex < progress.subIndex) continue;
        records.push(record);
      }
      for (const threadId of projected.discoveredChildThreadIds) {
        if (seenThreadIds.has(threadId)) continue;
        seenThreadIds.add(threadId);
        const childFiles = await collectCodexSessionRolloutFiles({ codexHome: params.codexHome, remoteSessionId: threadId });
        for (const file of childFiles) {
          const childStream: CodexDirectTranscriptRolloutStream = { ...file, threadId, sidechainId: threadId };
          if (streamsById.has(childStream.fileRelPath)) continue;
          streamsById.set(childStream.fileRelPath, childStream);
          streamQueue.push(childStream);
        }
      }
    }
  }

  records.sort(compareCodexProjectedRecordsOldestFirst);
  const streams = [...streamsById.values()].sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
  return { streams, records, baseProgressByStreamId };
}

export async function readAfterCodexRolloutStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const streams = await collectCodexDirectTranscriptRolloutStreams({
    codexHome: params.codexHome,
    remoteSessionId: params.remoteSessionId,
    initialRolloutFiles: params.initialRolloutFiles,
  });

  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: await buildCodexStreamVectorTailCursor(streams),
      truncated: false,
    };
  }

  const decoded = decodeCodexDirectForwardCursor(params.cursor);
  const cursorProgressByStreamId = decodeStreamVectorCursor(decoded);
  if (!cursorProgressByStreamId) {
    return {
      items: [],
      nextCursor: await buildCodexStreamVectorTailCursor(streams),
      truncated: true,
    };
  }

  const collected = await collectReadAfterRecords({
    codexHome: params.codexHome,
    initialStreams: streams,
    initialProgressByStreamId: cursorProgressByStreamId,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const items: DirectTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let truncated = false;
  const progressByStreamId = new Map(collected.baseProgressByStreamId);

  for (let index = 0; index < collected.records.length; index += 1) {
    const record = collected.records[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(record.item);
    if (items.length > 0 && (items.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      truncated = true;
      break;
    }
    items.push(record.item);
    usedBytes += itemBytes;
    progressByStreamId.set(record.streamId, record.subIndex + 1 >= record.lineRecordCount
      ? { nextOffsetBytes: record.lineNextOffsetBytes, subIndex: 0 }
      : { nextOffsetBytes: record.lineStartOffsetBytes, subIndex: record.subIndex + 1 });
    if (items.length >= maxItems || usedBytes >= maxBytes) {
      truncated = index + 1 < collected.records.length;
      break;
    }
  }

  return {
    items,
    nextCursor: buildStreamVectorCursorFromProgress(collected.streams, progressByStreamId),
    truncated,
  };
}

export async function pageCodexRolloutStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
  const streams = await collectCodexDirectTranscriptRolloutStreams({
    codexHome: params.codexHome,
    remoteSessionId: params.remoteSessionId,
    initialRolloutFiles: params.initialRolloutFiles,
  });
  const tailCursor = await buildCodexStreamVectorTailCursor(streams);

  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor, hasMore: false };
  }

  const decoded = decodeCodexDirectBackwardCursor(params.cursor);
  const endByStreamId = new Map(decoded?.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const) ?? []);
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const reachedStartByStreamId = new Map<string, boolean>();
  const initialEndByStreamId = new Map<string, number>();
  const pageNextEndByStreamId = new Map<string, number>();
  const hasLoadedCandidateByStreamId = new Map<string, boolean>();

  for (const stream of streams) {
    const fileSize = await statFileSize(stream.filePath);
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    initialEndByStreamId.set(stream.fileRelPath, endOffsetBytes);
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    reachedStartByStreamId.set(stream.fileRelPath, page.reachedStart);
    pageNextEndByStreamId.set(stream.fileRelPath, page.nextEndOffsetBytes);
    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const line of page.items) {
      const projected = projectCodexRolloutLineToTranscriptRecords({
        codexHome: params.codexHome,
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineNextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.records.length > 0) {
        hasLoadedCandidateByStreamId.set(stream.fileRelPath, true);
      }
      candidateRecords.push(...projected.records);
    }
  }

  candidateRecords.sort(compareCodexProjectedRecordsOldestFirst);
  const selectedReversed: CodexProjectedTranscriptRecord[] = [];
  let usedBytes = 0;
  for (let index = candidateRecords.length - 1; index >= 0; index -= 1) {
    const record = candidateRecords[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(record.item);
    if (selectedReversed.length > 0 && (selectedReversed.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    selectedReversed.push(record);
    usedBytes += itemBytes;
    if (selectedReversed.length >= maxItems || usedBytes >= maxBytes) {
      break;
    }
  }

  const selected = selectedReversed.reverse();
  const nextEndByStreamId = new Map<string, number>();
  for (const stream of streams) {
    const initialEndOffsetBytes = initialEndByStreamId.get(stream.fileRelPath) ?? 0;
    const pageNextEndOffsetBytes = pageNextEndByStreamId.get(stream.fileRelPath) ?? initialEndOffsetBytes;
    nextEndByStreamId.set(
      stream.fileRelPath,
      hasLoadedCandidateByStreamId.get(stream.fileRelPath) === true
        ? initialEndOffsetBytes
        : pageNextEndOffsetBytes,
    );
  }
  for (const record of selected) {
    const current = nextEndByStreamId.get(record.streamId);
    if (current == null || record.lineStartOffsetBytes < current) {
      nextEndByStreamId.set(record.streamId, record.lineStartOffsetBytes);
    }
  }

  const selectedIds = new Set(selected.map((record) => record.item.id));
  const hasUndeliveredLoadedRecord = candidateRecords.some((record) => !selectedIds.has(record.item.id));
  const mayHaveUndeliveredRecordBeforeLoadedWindow = streams.some((stream) => {
    const endOffsetBytes = nextEndByStreamId.get(stream.fileRelPath) ?? 0;
    return endOffsetBytes > 0 && reachedStartByStreamId.get(stream.fileRelPath) === false;
  });
  const hasMore = hasUndeliveredLoadedRecord || mayHaveUndeliveredRecordBeforeLoadedWindow;
  const nextCursor = hasMore
    ? encodeCodexDirectBackwardCursor({
      v: 3,
      kind: 'codexBackwardStreamVector',
      streams: [...nextEndByStreamId.entries()]
        .map(([fileRelPath, endOffsetBytes]) => ({ fileRelPath, endOffsetBytes }))
        .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
    })
    : null;

  return {
    items: selected.map((record) => record.item),
    nextCursor,
    tailCursor,
    hasMore,
    ...(decoded === null && typeof params.cursor === 'string' && params.cursor.trim().length > 0 ? { truncated: true } : {}),
  };
}
