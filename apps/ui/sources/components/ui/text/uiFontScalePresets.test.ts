import { describe, expect, it } from 'vitest';

import {
    APPEARANCE_UI_FONT_SCALE_PRESETS,
    HEADER_UI_FONT_SCALE_PRESETS,
} from './uiFontScalePresets';

describe('uiFontScalePresets', () => {
    it('keeps the official small appearance presets and adds all header scale targets', () => {
        expect(APPEARANCE_UI_FONT_SCALE_PRESETS.map((preset) => preset.scale)).toEqual([
            0.8, 0.85, 0.93, 1, 1.1, 1.2, 1.3, 1.5, 2, 3,
        ]);
        expect(HEADER_UI_FONT_SCALE_PRESETS.map((preset) => preset.scale)).toEqual([
            1, 1.1, 1.2, 1.3, 1.5, 2, 3,
        ]);
    });
});
