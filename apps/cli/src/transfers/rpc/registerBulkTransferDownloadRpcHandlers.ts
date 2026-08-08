import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { parseTransferRecipientPublicKeyBase64 } from '@/machines/transfer/transferChunkEncryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import { resolveWorkspaceFileDownloadSource } from '../targets/resolveWorkspaceFileDownloadSource';
import { registerDownloadTransferLifecycleHandlers } from './registerDownloadTransferLifecycleHandlers';
import { resolveDirectCodexSessionMedia } from '@/backends/codex/directSessions/directCodexSessionMedia';
import type { Metadata } from '@/api/types';
import { join } from 'node:path';
import { getDirectSessionProviderOps } from '@/backends/catalog';

type BulkTransferDownloadInitRequest = Readonly<{
  t: 'session_file_download_v1';
  path: string;
  asZip?: boolean;
  recipientPublicKeyBase64?: string;
}> | Readonly<{
  t: 'direct_codex_session_media_preview_v1';
  directMediaId: string;
  path: string;
  recipientPublicKeyBase64?: string;
}>;

type BulkTransferDownloadInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function envelopePublishesDirectMedia(envelopeValue: unknown, mediaId: string, path: string): boolean {
  const envelope = asRecord(envelopeValue);
  if (envelope?.kind !== 'direct_session_media.v1') return false;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  return media.some((value) => {
    const item = asRecord(value);
    return item?.id === mediaId && item.path === path;
  });
}

function transcriptItemPublishesDirectMedia(itemValue: unknown, mediaId: string, path: string): boolean {
  const item = asRecord(itemValue);
  const raw = asRecord(item?.raw);
  const meta = asRecord(raw?.meta);
  return envelopePublishesDirectMedia(meta?.happier, mediaId, path)
    || envelopePublishesDirectMedia(meta?.happierMedia, mediaId, path);
}

async function linkedTranscriptPublishesDirectMedia(params: Readonly<{
  source: NonNullable<Metadata['directSessionV1']>['source'];
  remoteSessionId: string;
  mediaId: string;
  path: string;
}>): Promise<boolean> {
  const providerOps = await getDirectSessionProviderOps('codex');
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
    const page = await providerOps.pageTranscript({
      source: params.source,
      remoteSessionId: params.remoteSessionId,
      direction: 'older',
      ...(cursor ? { cursor } : {}),
      maxBytes: 512_000,
      maxItems: 500,
    });
    if (page.items.some((item) => transcriptItemPublishesDirectMedia(item, params.mediaId, params.path))) {
      return true;
    }
    if (!page.hasMore || !page.nextCursor) return false;
    cursor = page.nextCursor;
  }
  return false;
}

export function registerBulkTransferDownloadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    store: TransferSessionStore;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
    getSessionMetadata?: () => Metadata | null;
  }>,
): void {
  registerDownloadTransferLifecycleHandlers<BulkTransferDownloadInitResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as BulkTransferDownloadInitRequest | null;
      if (!request || (request.t !== 'session_file_download_v1' && request.t !== 'direct_codex_session_media_preview_v1')) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Invalid request',
          },
        };
      }

      const recipientPublicKeyBase64 = typeof request.recipientPublicKeyBase64 === 'string'
        ? request.recipientPublicKeyBase64.trim()
        : '';
      if (!recipientPublicKeyBase64) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Missing recipientPublicKeyBase64',
          },
        };
      }
      try {
        // Validate early so init fails closed instead of crashing later during chunk encryption.
        parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
      } catch (error) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid recipientPublicKeyBase64',
          },
        };
      }
      if (request.t === 'direct_codex_session_media_preview_v1') {
        const metadata = deps.getSessionMetadata?.();
        if (metadata?.directSessionV1?.providerId !== 'codex') {
          return { kind: 'rejected', response: { success: false, error: 'Direct Codex media preview is unavailable for this session' } };
        }
        const directMediaId = typeof request.directMediaId === 'string' ? request.directMediaId.trim() : '';
        if (!directMediaId || directMediaId.length > 512) {
          return { kind: 'rejected', response: { success: false, error: 'Direct Codex media identity is invalid' } };
        }
        const source = metadata.directSessionV1.source;
        const published = await linkedTranscriptPublishesDirectMedia({
          source,
          remoteSessionId: metadata.directSessionV1.remoteSessionId,
          mediaId: directMediaId,
          path: request.path,
        }).catch(() => false);
        if (!published) {
          return { kind: 'rejected', response: { success: false, error: 'Direct Codex media was not published by this session' } };
        }
        const sourceHome = source?.kind === 'codexHome' && typeof source.homePath === 'string' ? source.homePath.trim() : '';
        const codexHome = sourceHome || (typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : '');
        const item = codexHome ? resolveDirectCodexSessionMedia({
          codexHome,
          sourcePath: join(codexHome, request.path),
          id: 'preview',
          maxBytes: deps.sessionRpcTransferMaxBytes ?? undefined,
        }) : null;
        if (!item) return { kind: 'rejected', response: { success: false, error: 'Direct Codex media path is unavailable' } };
        return {
          kind: 'accepted',
          source: { filePath: join(codexHome, item.path), sizeBytes: item.sizeBytes, name: item.name, deleteFileOnClose: false },
          recipientPublicKeyBase64,
          logContext: { path: item.path, directCodexPreview: true },
        };
      }
      const source = await resolveWorkspaceFileDownloadSource({
        workingDirectory: deps.workingDirectory,
        accessPolicy: deps.accessPolicy,
        path: request.path,
        asZip: request.asZip,
        additionalAllowedReadDirs: deps.getAdditionalAllowedReadDirs?.(),
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
      });
      if (!source.success) {
        return { kind: 'rejected', response: source };
      }
      return {
        kind: 'accepted',
        source: source.source,
        recipientPublicKeyBase64,
        logContext: {
          path: request.path,
          asZip: Boolean(request.asZip),
        },
      };
    },
    buildInitSuccessResponse: ({ session, source }) => ({
      success: true,
      downloadId: session.downloadId,
      chunkSizeBytes: session.chunkSizeBytes,
      sizeBytes: source.sizeBytes,
      name: source.name,
    }),
    buildInitErrorResponse: (error) => ({ success: false, error: error instanceof Error ? error.message : 'Download init failed' }),
  });
}
