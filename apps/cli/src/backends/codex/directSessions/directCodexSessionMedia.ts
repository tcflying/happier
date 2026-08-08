import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';

import { resolveSessionMediaMimeType, type SupportedSessionMediaMimeType } from '@/session/sessionMedia/sessionMediaMime';

export const DIRECT_CODEX_SESSION_MEDIA_META_KIND_V1 = 'direct_session_media.v1';
export const MAX_DIRECT_CODEX_MEDIA_BYTES = 25 * 1024 * 1024;

export type DirectCodexSessionMediaItemV1 = Readonly<{
  id: string;
  mediaKind: 'image';
  name: string;
  path: string;
  mimeType: SupportedSessionMediaMimeType;
  sizeBytes: number;
}>;

function isPortableRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(value) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isCanonicalChild(root: string, candidate: string): boolean {
  const rel = relative(root, candidate).replace(/\\/g, '/');
  return isPortableRelativePath(rel);
}

/**
 * Resolves a Codex-owned image only when both the configured CODEX_HOME and the
 * candidate file resolve to the same real filesystem tree. The returned path is
 * deliberately portable and relative: direct transcripts must never persist a
 * host path, URI, or symlink escape.
 */
export function resolveDirectCodexSessionMedia(params: Readonly<{
  codexHome: string;
  sourcePath: string;
  id: string;
  maxBytes?: number;
}>): DirectCodexSessionMediaItemV1 | null {
  if (!params.id || !params.sourcePath || /^(?:\\\\|file:|https?:|data:)/i.test(params.sourcePath)) return null;
  try {
    const canonicalHome = realpathSync(params.codexHome);
    const sourceLstat = lstatSync(params.sourcePath);
    if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) return null;
    const canonicalSource = realpathSync(params.sourcePath);
    if (!isCanonicalChild(canonicalHome, canonicalSource)) return null;
    const sourceStat = statSync(canonicalSource);
    const maxBytes = params.maxBytes ?? MAX_DIRECT_CODEX_MEDIA_BYTES;
    if (sourceStat.size <= 0 || sourceStat.size > maxBytes) return null;
    const path = relative(canonicalHome, canonicalSource).replace(/\\/g, '/');
    if (!isPortableRelativePath(path)) return null;
    const mimeType = resolveSessionMediaMimeType({
      bytes: readFileSync(canonicalSource).subarray(0, 4096),
      suggestedName: basename(path),
    });
    if (!mimeType) return null;
    return { id: params.id, mediaKind: 'image', name: basename(path), path, mimeType, sizeBytes: sourceStat.size };
  } catch {
    return null;
  }
}
