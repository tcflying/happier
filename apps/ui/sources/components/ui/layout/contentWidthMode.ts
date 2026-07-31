import { CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS } from '@/utils/platform/viewportClass';

export type UiContentWidthMode = 'compact' | 'medium' | 'full';

export const CONTENT_WIDTH_PX_BY_MODE = Object.freeze({
    compact: 850,
    medium: CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.medium,
} satisfies Record<Exclude<UiContentWidthMode, 'full'>, number>);

export function normalizeUiContentWidthMode(value: unknown): UiContentWidthMode {
    if (value === 'compact' || value === 'medium') return value;
    return 'full';
}

export function resolveContentMaxWidthForMode(mode: unknown): number {
    const normalizedMode = normalizeUiContentWidthMode(mode);
    if (normalizedMode === 'full') return Number.POSITIVE_INFINITY;
    return CONTENT_WIDTH_PX_BY_MODE[normalizedMode];
}
