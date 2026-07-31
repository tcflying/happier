import { describe, expect, it } from 'vitest';

import { resolveTranscriptToolCallsCollapsedPreviewCount } from './transcriptToolCallsCollapsedPreviewCount';

describe('resolveTranscriptToolCallsCollapsedPreviewCount', () => {
    it('defaults to a header-only collapsed tool group', () => {
        expect(resolveTranscriptToolCallsCollapsedPreviewCount(undefined)).toBe(0);
        expect(resolveTranscriptToolCallsCollapsedPreviewCount(Number.NaN)).toBe(0);
    });

    it('keeps an explicit preview count as an opt-in', () => {
        expect(resolveTranscriptToolCallsCollapsedPreviewCount(3)).toBe(3);
    });
});
