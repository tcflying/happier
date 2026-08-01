import { describe, expect, it } from 'vitest';

import { normalizeUiContentWidthMode, resolveContentMaxWidthForMode } from './contentWidthMode';

describe('contentWidthMode', () => {
    it('defaults an unset or invalid width preference to full width', () => {
        expect(normalizeUiContentWidthMode(undefined)).toBe('full');
        expect(normalizeUiContentWidthMode('invalid')).toBe('full');
        expect(resolveContentMaxWidthForMode(undefined)).toBe(Number.POSITIVE_INFINITY);
    });
});
