import { AttachmentsMessageMetaV1Schema, type AttachmentsMessageMetaV1 } from '@/sync/domains/attachments/attachmentsMessageMeta';
import {
    SessionMediaItemV1Schema,
    SessionMediaMessageMetaEnvelopeV1Schema,
} from '@happier-dev/protocol';

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
    description?: string;
    category?: 'attachment' | 'generated' | 'tool-artifact';
    role?: 'input' | 'output';
    previewSource?: 'session-media' | 'direct-codex';
}>;

export type SessionMediaUnavailableSummary = Readonly<{
    id: string;
    category: 'attachment' | 'generated' | 'tool-artifact';
    code: string;
}>;

export type ParsedSessionMediaMessageMeta = Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
    unavailableMedia: readonly SessionMediaUnavailableSummary[];
    legacyAttachments: AttachmentsMessageMetaV1 | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvelope(meta: unknown, key: 'happier' | 'happierMedia' | 'happierAttachments'): HappierMetaEnvelope | null {
    if (!isRecord(meta)) return null;
    const envelope = meta[key];
    if (!isRecord(envelope)) return null;
    return typeof envelope.kind === 'string' ? envelope as HappierMetaEnvelope : null;
}

function normalizeSessionMediaItem(value: unknown): SessionMediaInlineImageSummary | null {
    const parsed = SessionMediaItemV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const item = parsed.data;

    return {
        id: item.id,
        name: item.name,
        path: item.path,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.sha256 ? { sha256: item.sha256 } : {}),
        ...(item.description ? { description: item.description } : {}),
        category: item.category,
        role: item.role,
    };
}

function parseSessionMediaEnvelope(envelope: HappierMetaEnvelope | null): Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
    unavailableMedia: readonly SessionMediaUnavailableSummary[];
}> {
    const parsed = SessionMediaMessageMetaEnvelopeV1Schema.safeParse(envelope);
    if (!parsed.success) return { inlineImages: [], unavailableMedia: [] };
    return {
        inlineImages: parsed.data.payload.media.flatMap((item) => {
            const normalized = normalizeSessionMediaItem(item);
            return normalized ? [normalized] : [];
        }),
        unavailableMedia: (parsed.data.payload.unavailable ?? []).map((item) => ({
            id: item.id,
            category: item.category,
            code: item.code,
        })),
    };
}

function parseDirectCodexSessionMediaEnvelope(envelope: HappierMetaEnvelope | null, enabled: boolean): readonly SessionMediaInlineImageSummary[] {
    if (!enabled || envelope?.kind !== 'direct_session_media.v1' || !isRecord(envelope.payload)) return [];
    const media = Array.isArray(envelope.payload.media) ? envelope.payload.media : [];
    if (media.length === 0 || media.length > 64) return [];
    return media.flatMap((value) => {
        if (!isRecord(value)) return [];
        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        const path = typeof value.path === 'string' ? value.path.trim() : '';
        const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim().toLowerCase() : '';
        const sizeBytes = typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) ? value.sizeBytes : 0;
        if (!id || id.length > 512 || !name || name.length > 512 || !isDirectCodexRelativePath(path)
            || !DIRECT_IMAGE_MIME_TYPES.has(mimeType) || sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024) return [];
        return [{ id, name, path, mimeType, sizeBytes, category: 'generated' as const, role: 'output' as const, previewSource: 'direct-codex' as const }];
    });
}

const DIRECT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

function isDirectCodexRelativePath(value: string): boolean {
    if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || /^[a-zA-Z]:/.test(value)
        || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
    return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
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

export function parseSessionMediaMessageMeta(meta: unknown, options?: Readonly<{ allowDirectCodexMedia?: boolean }>): ParsedSessionMediaMessageMeta {
    const primaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happier'));
    const secondaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happierMedia'));
    const legacyAttachments = parseLegacyAttachmentsMeta(meta);
    const legacyMedia = legacyAttachments ? normalizeAttachmentMetaToSessionMedia(legacyAttachments.attachments) : [];
    const directCodexMedia = parseDirectCodexSessionMediaEnvelope(primaryEnvelope(meta), options?.allowDirectCodexMedia === true);

    return {
        inlineImages: dedupeMedia([...primaryMedia.inlineImages, ...secondaryMedia.inlineImages, ...legacyMedia, ...directCodexMedia]),
        unavailableMedia: [...primaryMedia.unavailableMedia, ...secondaryMedia.unavailableMedia],
        legacyAttachments,
    };
}

function primaryEnvelope(meta: unknown): HappierMetaEnvelope | null {
    return readEnvelope(meta, 'happier');
}

function dedupeMedia(items: readonly SessionMediaInlineImageSummary[]): readonly SessionMediaInlineImageSummary[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = `${item.previewSource ?? 'session-media'}:${item.path}:${item.sha256 ?? item.id ?? item.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function hasSessionMediaRenderItems(meta: unknown): boolean {
    const parsed = parseSessionMediaMessageMeta(meta);
    return parsed.inlineImages.length > 0 || parsed.unavailableMedia.length > 0;
}
