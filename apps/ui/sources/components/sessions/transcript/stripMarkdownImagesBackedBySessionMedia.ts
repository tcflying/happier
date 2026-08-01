import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function normalizePathKey(value: string): string {
    let decoded = value.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // Keep the original target when it is not URI encoded.
    }
    const normalized = decoded.replace(/\\/g, '/');
    return /^[a-zA-Z]:\//.test(normalized)
        ? normalized.toLocaleLowerCase('en-US')
        : normalized;
}

export function stripMarkdownImagesBackedBySessionMedia(
    markdown: string,
    media: readonly SessionMediaInlineImageSummary[],
): string {
    if (media.length === 0 || !markdown.includes('![')) return markdown;
    const mediaPaths = new Set(media.map((item) => normalizePathKey(item.path)));
    const stripped = markdown.replace(MARKDOWN_IMAGE_PATTERN, (source, angleTarget, plainTarget) => {
        const target = String(angleTarget ?? plainTarget ?? '');
        return mediaPaths.has(normalizePathKey(target)) ? '' : source;
    });
    return stripped.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
}
