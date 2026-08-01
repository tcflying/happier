import { AttachmentsMessageMetaV1Schema, type AttachmentsMessageMetaV1 } from '@/sync/domains/attachments/attachmentsMessageMeta';

type HappierMetaEnvelope = Readonly<{
    kind: string;
    payload?: unknown;
}>;

export type SessionMediaInlineImageSummary = Readonly<{
    id?: string;
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    width?: number;
    height?: number;
    sha256?: string;
    category?: 'attachment' | 'generated' | 'tool-artifact';
    role?: 'input' | 'output';
}>;

export type ParsedSessionMediaMessageMeta = Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
    legacyAttachments: AttachmentsMessageMetaV1 | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvelope(meta: unknown, key: 'happier' | 'happierMedia' | 'happierAttachments' | 'happierDirectMedia'): HappierMetaEnvelope | null {
    if (!isRecord(meta)) return null;
    const envelope = meta[key];
    if (!isRecord(envelope)) return null;
    return typeof envelope.kind === 'string' ? envelope as HappierMetaEnvelope : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function isSafeSessionMediaPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.length === 0) return false;
    if (normalized.startsWith('/') || normalized.startsWith('file://')) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return false;
    if (/^[a-zA-Z]:\//.test(normalized)) return false;
    if (normalized === '.' || normalized === '..') return false;
    if (normalized.startsWith('../') || normalized.includes('/../')) return false;
    return true;
}

function isTrustedDirectSessionMediaPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('file://')) return false;
    if (normalized.startsWith('//')) return false;
    if (normalized.split('/').includes('..')) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) && !/^[a-zA-Z]:\//.test(normalized)) return false;
    return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
}

function isSessionMediaRole(value: unknown): value is 'input' | 'output' {
    return value === 'input' || value === 'output';
}

function isSessionMediaCategory(value: unknown): value is 'attachment' | 'generated' | 'tool-artifact' {
    return value === 'attachment' || value === 'generated' || value === 'tool-artifact';
}

function normalizeSessionMediaItem(
    value: unknown,
    pathPolicy: 'workspace-relative' | 'trusted-direct' = 'workspace-relative',
): SessionMediaInlineImageSummary | null {
    if (!isRecord(value)) return null;
    if (value.mediaKind !== 'image') return null;

    const name = readNonEmptyString(value.name);
    const path = readNonEmptyString(value.path);
    const sizeBytes = typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes)
        ? Math.max(0, value.sizeBytes)
        : null;
    if (!name || !path || sizeBytes == null) return null;
    const validPath = pathPolicy === 'trusted-direct'
        ? isTrustedDirectSessionMediaPath(path)
        : isSafeSessionMediaPath(path);
    if (!validPath) return null;

    const mimeType = readNonEmptyString(value.mimeType);
    const sha256 = readNonEmptyString(value.sha256);
    const id = readNonEmptyString(value.id);
    const width = readPositiveInteger(value.width);
    const height = readPositiveInteger(value.height);
    const role = isSessionMediaRole(value.role) ? value.role : undefined;
    const category = isSessionMediaCategory(value.category) ? value.category : undefined;

    return {
        ...(id ? { id } : {}),
        name,
        path,
        ...(mimeType ? { mimeType } : {}),
        sizeBytes,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(sha256 ? { sha256 } : {}),
        ...(category ? { category } : {}),
        ...(role ? { role } : {}),
    };
}

function parseSessionMediaEnvelope(envelope: HappierMetaEnvelope | null): readonly SessionMediaInlineImageSummary[] {
    if (envelope?.kind !== 'session_media.v1') return [];
    const payload = envelope.payload;
    if (!isRecord(payload) || !Array.isArray(payload.media)) return [];
    return payload.media.flatMap((item) => {
        const normalized = normalizeSessionMediaItem(item);
        return normalized ? [normalized] : [];
    });
}

function parseDirectSessionMediaEnvelope(envelope: HappierMetaEnvelope | null): readonly SessionMediaInlineImageSummary[] {
    if (envelope?.kind !== 'direct_session_media.v1') return [];
    const payload = envelope.payload;
    if (!isRecord(payload) || !Array.isArray(payload.media)) return [];
    return payload.media.flatMap((item) => {
        const normalized = normalizeSessionMediaItem(item, 'trusted-direct');
        return normalized ? [normalized] : [];
    });
}

export function normalizeAttachmentMetaToSessionMedia(
    attachments: AttachmentsMessageMetaV1['attachments'],
): readonly SessionMediaInlineImageSummary[] {
    return attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        sizeBytes: attachment.sizeBytes,
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        category: 'attachment',
        role: 'input',
    }));
}

function parseLegacyAttachmentsMeta(meta: unknown): AttachmentsMessageMetaV1 | null {
    const primaryEnvelope = readEnvelope(meta, 'happier');
    const envelope = primaryEnvelope?.kind === 'attachments.v1'
        ? primaryEnvelope
        : readEnvelope(meta, 'happierAttachments');
    if (envelope?.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.attachments.length === 0) return null;
    return parsed.data;
}

export function parseSessionMediaMessageMeta(
    meta: unknown,
    options: Readonly<{ allowTrustedDirectMedia?: boolean }> = {},
): ParsedSessionMediaMessageMeta {
    const primaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happier'));
    const secondaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happierMedia'));
    const directMedia = options.allowTrustedDirectMedia === true
        ? parseDirectSessionMediaEnvelope(readEnvelope(meta, 'happierDirectMedia'))
        : [];
    const legacyAttachments = parseLegacyAttachmentsMeta(meta);
    const legacyMedia = legacyAttachments ? normalizeAttachmentMetaToSessionMedia(legacyAttachments.attachments) : [];

    return {
        inlineImages: [...primaryMedia, ...secondaryMedia, ...directMedia, ...legacyMedia],
        legacyAttachments,
    };
}

export function hasSessionMediaRenderItems(meta: unknown): boolean {
    return parseSessionMediaMessageMeta(meta).inlineImages.length > 0;
}
