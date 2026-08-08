import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { CodexRolloutAction } from '../localControl/rolloutMapper';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import {
  DIRECT_CODEX_SESSION_MEDIA_META_KIND_V1,
  resolveDirectCodexSessionMedia,
} from './directCodexSessionMedia';

function shouldFilterHarnessBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Known harness/system blobs embedded as user content (replay sessions, agent harness, etc).
  const patterns = [
    '# AGENTS.md instructions',
    '<environment_context>',
    '<turn_aborted>',
    '<INSTRUCTIONS>',
    'You are GPT-',
    'Codex CLI is an open source project',
  ];
  return patterns.some((p) => t.includes(p));
}

function extractEnvelopeTimestampMs(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const ts = typeof (value as any).timestamp === 'string' ? String((value as any).timestamp) : '';
  if (!ts.trim()) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
}

function stableOffsetId(prefix: string, offset: number, actionIndex: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  const idx = Math.max(0, Math.trunc(actionIndex)).toString().padStart(3, '0');
  return `${prefix}:${padded}:${idx}`;
}

export function mapCodexRolloutLineToDirectMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
  actions: ReadonlyArray<CodexRolloutAction>;
  sidechainId?: string | null;
  codexHome: string;
}>): DirectTranscriptRawMessageV1[] {
  const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
  // Direct transcript rendering should include "debug-only" tool calls (e.g., Codex-internal read/write tools),
  // but must still filter harness/system blobs that Codex sometimes embeds as user messages.
  const projected = projectCodexRolloutActions(
    params.actions,
    { sidechainId: params.sidechainId ?? null },
  );

  const out: DirectTranscriptRawMessageV1[] = [];
  const directMedia = readDirectCodexImageMedia({
    lineValue: params.lineValue,
    codexHome: params.codexHome,
    id: stableOffsetId(`codex:${params.fileRelPath}:media`, params.lineStartOffsetBytes, 0),
  });
  if (directMedia) {
    out.push({
      id: stableOffsetId(`codex:${params.fileRelPath}:media`, params.lineStartOffsetBytes, 0),
      localId: stableOffsetId(`codex:${params.fileRelPath}:media`, params.lineStartOffsetBytes, 0),
      createdAtMs,
      raw: {
        role: 'agent',
        // Use the existing Codex message shape so normalization keeps this
        // media-only row silent instead of emitting an unsupported-output marker.
        content: { type: 'codex', data: { type: 'message', message: '' } },
        meta: { happier: { kind: DIRECT_CODEX_SESSION_MEDIA_META_KIND_V1, payload: { media: [directMedia] } } },
      },
    });
  }
  for (let i = 0; i < projected.length; i++) {
    const action = projected[i]!;
    const idPrefix = `codex:${params.fileRelPath}`;
    const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes, i);

    if (action.type === 'user-text') {
      if (shouldFilterHarnessBlob(action.text)) continue;
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'user',
          content: { type: 'text', text: action.text },
        },
      });
      continue;
    }

    if (action.type === 'assistant-text') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: action.text,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'context-compaction') {
      if (action.sidechainId) continue;
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'event',
            id: stableId,
            data: {
              type: 'context-compaction',
              phase: action.phase,
              lifecycleId: action.lifecycleId,
              provider: 'codex',
              source: action.source,
              ...(action.providerEventId ? { providerEventId: action.providerEventId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-call') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: action.callId,
              name: action.name,
              input: action.input,
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-result') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call-result',
              callId: action.callId,
              output: action.output,
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
              ...(action.isError ? { isError: action.isError } : {}),
            },
          },
        },
      });
      continue;
    }
  }

  return out;
}

function readDirectCodexImageMedia(params: Readonly<{ lineValue: unknown; codexHome: string; id: string }>) {
  if (!params.lineValue || typeof params.lineValue !== 'object' || Array.isArray(params.lineValue)) return null;
  const payload = (params.lineValue as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type !== 'image_generation_call' && type !== 'image_generation') return null;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (status && status !== 'completed' && status !== 'succeeded') return null;
  const path = typeof record.saved_path === 'string' ? record.saved_path : typeof record.savedPath === 'string' ? record.savedPath : null;
  const imageId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : params.id;
  return path ? resolveDirectCodexSessionMedia({ codexHome: params.codexHome, sourcePath: path, id: imageId }) : null;
}
