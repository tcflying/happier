import { describe, expect, it } from 'vitest';

import { hasToolPayloadForRendering } from './ToolInlineBody';

describe('hasToolPayloadForRendering', () => {
    it('does not create empty input or output detail sections', () => {
        expect(hasToolPayloadForRendering(null)).toBe(false);
        expect(hasToolPayloadForRendering('   ')).toBe(false);
        expect(hasToolPayloadForRendering({})).toBe(false);
        expect(hasToolPayloadForRendering([])).toBe(false);
    });

    it('keeps meaningful scalar and structured payloads visible', () => {
        expect(hasToolPayloadForRendering(false)).toBe(true);
        expect(hasToolPayloadForRendering(0)).toBe(true);
        expect(hasToolPayloadForRendering({ command: 'pwd' })).toBe(true);
        expect(hasToolPayloadForRendering(['result'])).toBe(true);
    });
});
