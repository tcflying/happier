import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { TransferPathAllowanceRegistry } from '../targets/createTransferPathAllowanceRegistry';
import { registerBulkTransferDownloadRpcHandlers } from './registerBulkTransferDownloadRpcHandlers';
import { registerBulkTransferUploadRpcHandlers } from './registerBulkTransferUploadRpcHandlers';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

type DirectorySupplier = () => ReadonlyArray<string>;

export type SessionTransferRpcHandlerRegistration = Readonly<{
  transferSessionStore: TransferSessionStore;
  dispose: () => Promise<void>;
}>;

function normalizeTransferDirectories(getDirectories?: DirectorySupplier): string[] {
  const value = getDirectories?.() ?? [];
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function registerSessionTransferRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: DirectorySupplier;
    getAdditionalAllowedWriteDirs?: DirectorySupplier;
    sessionRpcTransferMaxBytes?: number | null;
    store?: TransferSessionStore;
    attachmentUpload?: Readonly<{
      pathAllowanceRegistry: TransferPathAllowanceRegistry;
    }>;
    getSessionMetadata?: () => import('@/api/types').Metadata | null;
  }>,
): SessionTransferRpcHandlerRegistration {
  const ownsStore = !deps.store;
  const store = deps.store ?? new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerBulkTransferUploadRpcHandlers(rpcHandlerManager, {
    workingDirectory: deps.workingDirectory,
    accessPolicy: deps.accessPolicy,
    store,
    getAdditionalAllowedWriteDirs: () => normalizeTransferDirectories(deps.getAdditionalAllowedWriteDirs),
    sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
    ...(deps.attachmentUpload ? { attachmentUpload: deps.attachmentUpload } : {}),
  });

  registerBulkTransferDownloadRpcHandlers(rpcHandlerManager, {
    workingDirectory: deps.workingDirectory,
    accessPolicy: deps.accessPolicy,
    store,
    getAdditionalAllowedReadDirs: () => normalizeTransferDirectories(deps.getAdditionalAllowedReadDirs),
    sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
    getSessionMetadata: deps.getSessionMetadata,
  });

  return {
    transferSessionStore: store,
    dispose: async () => {
      if (ownsStore) {
        await store.dispose();
      }
    },
  };
}
