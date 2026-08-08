import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import type { CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';

export type CodexDirectTranscriptRolloutStream = CodexRolloutFile & Readonly<{
  codexHome: string;
  threadId: string;
  sidechainId: string | null;
}>;

export type CodexStreamProgress = Readonly<{
  nextOffsetBytes: number;
  subIndex: number;
}>;

export type CodexProjectedTranscriptRecord = Readonly<{
  item: DirectTranscriptRawMessageV1;
  streamId: string;
  lineStartOffsetBytes: number;
  lineNextOffsetBytes: number;
  subIndex: number;
  lineRecordCount: number;
}>;

export function measureDirectTranscriptItemBytes(item: DirectTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function compareDirectTranscriptItemsOldestFirst(left: DirectTranscriptRawMessageV1, right: DirectTranscriptRawMessageV1): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  return left.id.localeCompare(right.id);
}

export function compareCodexProjectedRecordsOldestFirst(
  left: CodexProjectedTranscriptRecord,
  right: CodexProjectedTranscriptRecord,
): number {
  return compareDirectTranscriptItemsOldestFirst(left.item, right.item);
}

export function projectCodexRolloutLineToTranscriptRecords(params: Readonly<{
  stream: CodexDirectTranscriptRolloutStream;
  lineStartOffsetBytes: number;
  lineNextOffsetBytes: number;
  lineValue: unknown;
  semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Readonly<{ records: readonly CodexProjectedTranscriptRecord[]; discoveredChildThreadIds: readonly string[] }> {
  const discoveredChildThreadIds = new Set<string>();
  const normalizedActions = mapCodexRolloutEventToActions(params.lineValue, { debug: true })
    .flatMap((action) => params.semanticTracker.consume(action));
  for (const action of normalizedActions) {
    if (action.type === 'subagent-spawn') {
      discoveredChildThreadIds.add(action.threadId);
    }
  }

  const items = mapCodexRolloutLineToDirectMessages({
    fileRelPath: params.stream.fileRelPath,
    lineStartOffsetBytes: params.lineStartOffsetBytes,
    lineValue: params.lineValue,
    actions: normalizedActions,
    sidechainId: params.stream.sidechainId,
    codexHome: params.stream.codexHome,
  });
  return {
    discoveredChildThreadIds: [...discoveredChildThreadIds],
    records: items.map((item, subIndex) => ({
      item,
      streamId: params.stream.fileRelPath,
      lineStartOffsetBytes: params.lineStartOffsetBytes,
      lineNextOffsetBytes: params.lineNextOffsetBytes,
      subIndex,
      lineRecordCount: items.length,
    })),
  };
}
