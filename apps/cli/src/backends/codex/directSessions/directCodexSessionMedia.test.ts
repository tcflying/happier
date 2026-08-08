import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDirectCodexSessionMedia } from './directCodexSessionMedia';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

describe('resolveDirectCodexSessionMedia', () => {
  it('returns only a canonical CODEX_HOME-relative image reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-codex-media-valid-'));
    const codexHome = join(root, 'codex-home');
    const imagePath = join(codexHome, 'images', 'generated.png');
    try {
      await mkdir(join(codexHome, 'images'), { recursive: true });
      await writeFile(imagePath, pngBytes);

      expect(resolveDirectCodexSessionMedia({ codexHome, sourcePath: imagePath, id: 'image-1' })).toEqual({
        id: 'image-1',
        mediaKind: 'image',
        name: 'generated.png',
        path: 'images/generated.png',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects URI, UNC, traversal, symlink escape, unsupported MIME, and oversized sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-direct-codex-media-reject-'));
    const codexHome = join(root, 'codex-home');
    const outsidePath = join(root, 'outside.png');
    const symlinkPath = join(codexHome, 'images', 'escape.png');
    const textPath = join(codexHome, 'images', 'not-image.txt');
    const oversizedPath = join(codexHome, 'images', 'oversized.png');
    try {
      await mkdir(join(codexHome, 'images'), { recursive: true });
      await writeFile(outsidePath, pngBytes);
      await writeFile(textPath, 'not an image', 'utf8');
      await writeFile(oversizedPath, pngBytes);
      await symlink(outsidePath, symlinkPath, 'file');

      const rejectedPaths = [
        'file:///tmp/image.png',
        'https://example.test/image.png',
        'http://example.test/image.png',
        'data:image/png;base64,AAAA',
        '\\\\server\\share\\image.png',
        outsidePath,
        join(codexHome, '..', 'outside.png'),
        symlinkPath,
        textPath,
      ];
      for (const sourcePath of rejectedPaths) {
        expect(resolveDirectCodexSessionMedia({ codexHome, sourcePath, id: 'image-rejected' })).toBeNull();
      }
      expect(resolveDirectCodexSessionMedia({
        codexHome,
        sourcePath: oversizedPath,
        id: 'image-oversized',
        maxBytes: pngBytes.byteLength - 1,
      })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
