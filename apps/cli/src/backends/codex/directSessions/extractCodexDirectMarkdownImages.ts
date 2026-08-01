import { posix, win32 } from 'node:path';

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export type CodexDirectMarkdownImage = Readonly<{
  role: 'output';
  category: 'generated';
  mediaKind: 'image';
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: 0;
}>;

function decodeMarkdownTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function usesWindowsPathSemantics(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function isPathInsideRoot(pathValue: string, rootValue: string): boolean {
  const windows = usesWindowsPathSemantics(pathValue) || usesWindowsPathSemantics(rootValue);
  const api = windows ? win32 : posix;
  const normalizedPath = api.normalize(pathValue);
  const normalizedRoot = api.normalize(rootValue);
  if (!api.isAbsolute(normalizedPath) || !api.isAbsolute(normalizedRoot)) return false;
  const relative = api.relative(normalizedRoot, normalizedPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
  );
}

function comparisonKey(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  return usesWindowsPathSemantics(pathValue) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function extractCodexDirectMarkdownImages(input: Readonly<{
  markdown: string;
  providerMediaRoot: string;
}>): readonly CodexDirectMarkdownImage[] {
  const images: CodexDirectMarkdownImage[] = [];
  const seen = new Set<string>();
  for (const match of input.markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const rawTarget = match[2] ?? match[3] ?? '';
    const filePath = decodeMarkdownTarget(rawTarget.trim());
    if (!filePath || !isPathInsideRoot(filePath, input.providerMediaRoot)) continue;

    const api = usesWindowsPathSemantics(filePath) ? win32 : posix;
    const extension = api.extname(filePath).toLocaleLowerCase('en-US');
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
    if (!mimeType) continue;

    const key = comparisonKey(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      name: api.basename(filePath),
      path: filePath,
      mimeType,
      sizeBytes: 0,
    });
  }
  return images;
}
