import { describe, expect, it } from 'vitest';

import { resolveCodeEditorFontMetrics } from './codeEditorFontMetrics';

describe('resolveCodeEditorFontMetrics', () => {
    it('applies uiFontScale and osFontScale', () => {
        const m = resolveCodeEditorFontMetrics({ uiFontScale: 2, osFontScale: 1.25 });
        expect(m.fontSize).toBe(33);
        expect(m.lineHeight).toBe(50);
        expect(m.scale).toBeCloseTo(2.5, 5);
    });

    it('preserves the 3x in-app font scale', () => {
        const metrics = resolveCodeEditorFontMetrics({ uiFontScale: 3, osFontScale: 1 });

        expect(metrics.scale).toBe(3);
        expect(metrics.fontSize).toBe(39);
        expect(metrics.lineHeight).toBe(60);
    });
});

