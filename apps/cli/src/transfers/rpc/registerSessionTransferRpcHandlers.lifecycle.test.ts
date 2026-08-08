import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';

import { registerSessionTransferRpcHandlers } from './registerSessionTransferRpcHandlers';

const getDirectSessionProviderOpsMock = vi.hoisted(() => vi.fn());

vi.mock('@/backends/catalog', () => ({
  getDirectSessionProviderOps: (...args: unknown[]) => getDirectSessionProviderOpsMock(...args),
}));

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('registerSessionTransferRpcHandlers lifecycle ownership', () => {
  beforeEach(() => {
    getDirectSessionProviderOpsMock.mockReset();
  });
  it('does not dispose a caller-owned injected store', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-transfer-injected-store-'));
    const { registrar } = createRegistrar();
    const store = new TransferSessionStore({ ttlMs: 1000 });

    try {
      const registration = registerSessionTransferRpcHandlers(registrar, {
        workingDirectory: workspace,
        store,
      });

      await registration.dispose();

      await expect(store.ensureTempRoot()).resolves.toBeUndefined();
    } finally {
      await store.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('disposes abandoned upload and download resources for the default store path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-transfer-registration-'));
    const { handlers, registrar } = createRegistrar();

    try {
      const registration = registerSessionTransferRpcHandlers(registrar, {
        workingDirectory: workspace,
      });

      const uploadInit = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      const downloadInit = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
      if (!uploadInit || !downloadInit) {
        throw new Error('expected transfer init handlers');
      }

      const uploadInitResult = await uploadInit({
        t: 'session_file_upload_v1',
        path: 'abandoned-upload.txt',
        sizeBytes: 4,
        overwrite: false,
      });
      expect(uploadInitResult).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadId = (uploadInitResult as { uploadId: string }).uploadId;
      const uploadSession = registration.transferSessionStore.getUploadSession(uploadId);
      expect(uploadSession).toBeTruthy();
      const uploadTempPath = uploadSession?.tempPath ?? '';
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const downloadDir = join(workspace, 'download-dir');
      await mkdir(downloadDir, { recursive: true });
      await writeFile(join(downloadDir, 'source.txt'), 'download me', 'utf8');
      const recipient = createTransferRecipientKeyPair();
      const downloadInitResult = await downloadInit({
        t: 'session_file_download_v1',
        path: 'download-dir',
        asZip: true,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(downloadInitResult).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadId = (downloadInitResult as { downloadId: string }).downloadId;
      const downloadSession = registration.transferSessionStore.getDownloadSession(downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession?.filePath ?? '';
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await registration.dispose();
      await registration.dispose();

      expect(registration.transferSessionStore.getUploadSession(uploadId)).toBeNull();
      expect(registration.transferSessionStore.getDownloadSession(downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('allows only the exact media id and path published by this linked Codex transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-codex-preview-gate-'));
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex-home');
    const imagePath = join(codexHome, 'images', 'generated.png');
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
      'base64',
    );
    const { handlers, registrar } = createRegistrar();
    let metadata: any = null;

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(codexHome, 'images'), { recursive: true });
      await writeFile(imagePath, pngBytes);
      const registration = registerSessionTransferRpcHandlers(registrar, {
        workingDirectory: workspace,
        getSessionMetadata: () => metadata,
      });
      const init = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
      if (!init) throw new Error('expected download init handler');
      const recipient = createTransferRecipientKeyPair();
      const request = {
        t: 'direct_codex_session_media_preview_v1',
        directMediaId: 'image-published',
        path: 'images/generated.png',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      } as const;

      await expect(init(request)).resolves.toMatchObject({ success: false });
      metadata = {
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        },
      };
      await expect(init(request)).resolves.toMatchObject({ success: false });

      metadata = {
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        },
      };
      const pageTranscript = vi.fn(async ({ remoteSessionId }: { remoteSessionId: string }) => ({
        items: remoteSessionId === 'remote-1'
          ? [{
              id: 'message-1',
              createdAtMs: 1,
              raw: {
                role: 'agent',
                meta: {
                  happier: {
                    kind: 'direct_session_media.v1',
                    payload: { media: [{ id: 'image-published', path: 'images/generated.png' }] },
                  },
                },
              },
            }]
          : [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
      }));
      getDirectSessionProviderOpsMock.mockResolvedValue({ pageTranscript });
      const accepted = await init(request);
      expect(accepted).toMatchObject({
        success: true,
        downloadId: expect.any(String),
        name: 'generated.png',
        sizeBytes: pngBytes.byteLength,
      });
      expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({ remoteSessionId: 'remote-1' }));

      await expect(init({ ...request, directMediaId: 'image-forged' })).resolves.toMatchObject({ success: false });
      await expect(init({ ...request, path: 'images/other.png' })).resolves.toMatchObject({ success: false });

      metadata = {
        directSessionV1: {
          ...metadata.directSessionV1,
          remoteSessionId: 'remote-2',
        },
      };
      await expect(init(request)).resolves.toMatchObject({ success: false });

      await registration.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
