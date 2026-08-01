import { describe, expect, it } from 'vitest';

import { stripMarkdownImagesBackedBySessionMedia } from './stripMarkdownImagesBackedBySessionMedia';

describe('stripMarkdownImagesBackedBySessionMedia', () => {
    it('removes only local markdown image nodes already rendered through session media', () => {
        const markdown = [
            'Before',
            '',
            '![proof](C:/Users/alice/.codex/visualizations/proof.png)',
            '',
            'After',
            '',
            '![remote](https://example.test/remote.png)',
        ].join('\n');

        expect(stripMarkdownImagesBackedBySessionMedia(markdown, [{
            name: 'proof.png',
            path: 'C:\\Users\\alice\\.codex\\visualizations\\proof.png',
            mimeType: 'image/png',
            sizeBytes: 0,
        }])).toBe([
            'Before',
            '',
            'After',
            '',
            '![remote](https://example.test/remote.png)',
        ].join('\n'));
    });

    it('keeps unmatched local image markdown unchanged', () => {
        const markdown = '![other](C:/Users/alice/.codex/visualizations/other.png)';

        expect(stripMarkdownImagesBackedBySessionMedia(markdown, [])).toBe(markdown);
    });
});
