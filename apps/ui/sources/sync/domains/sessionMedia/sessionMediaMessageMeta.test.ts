import { describe, expect, it } from 'vitest';

import { parseSessionMediaMessageMeta } from './sessionMediaMessageMeta';

function buildSessionMediaMeta(path: string): unknown {
    return {
        happier: {
            kind: 'session_media.v1',
            payload: {
                media: [
                    {
                        id: 'media-1',
                        role: 'output',
                        category: 'generated',
                        mediaKind: 'image',
                        name: 'generated.png',
                        path,
                        mimeType: 'image/png',
                        sizeBytes: 10,
                        origin: { source: 'provider-generated' },
                    },
                ],
            },
        },
    };
}

describe('parseSessionMediaMessageMeta', () => {
    it('preserves optional image dimensions for transcript layout', () => {
        const parsed = parseSessionMediaMessageMeta({
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [
                        {
                            id: 'media-1',
                            role: 'output',
                            category: 'generated',
                            mediaKind: 'image',
                            name: 'wide.png',
                            path: '.happier/uploads/generated/message-1/wide.png',
                            mimeType: 'image/png',
                            sizeBytes: 10,
                            width: 1600,
                            height: 900,
                            origin: { source: 'provider-generated' },
                        },
                    ],
                },
            },
        });

        expect(parsed.inlineImages[0]).toMatchObject({
            width: 1600,
            height: 900,
        });
    });

    it('ignores public URL and embedded-data media paths', () => {
        for (const path of [
            'https://example.test/generated.png',
            'http://example.test/generated.png',
            'blob:https://example.test/generated',
            'data:image/png;base64,AAAA',
        ]) {
            expect(parseSessionMediaMessageMeta(buildSessionMediaMeta(path)).inlineImages).toEqual([]);
        }
    });

    it('accepts absolute paths only from the trusted direct-session media envelope', () => {
        const directPath = 'C:/Users/alice/.codex/visualizations/proof.png';
        const directMeta = {
            happierDirectMedia: {
                kind: 'direct_session_media.v1',
                payload: {
                    media: [{
                        role: 'output',
                        category: 'generated',
                        mediaKind: 'image',
                        name: 'proof.png',
                        path: directPath,
                        mimeType: 'image/png',
                        sizeBytes: 0,
                    }],
                },
            },
        };
        expect(parseSessionMediaMessageMeta(directMeta).inlineImages).toEqual([]);

        const parsed = parseSessionMediaMessageMeta(directMeta, { allowTrustedDirectMedia: true });

        expect(parsed.inlineImages).toEqual([expect.objectContaining({
            path: directPath,
            name: 'proof.png',
            mimeType: 'image/png',
            sizeBytes: 0,
        })]);
        expect(parseSessionMediaMessageMeta(buildSessionMediaMeta(directPath)).inlineImages).toEqual([]);
    });

    it('rejects traversal and UNC paths even for trusted direct-session media', () => {
        for (const path of [
            'C:/Users/alice/.codex/visualizations/../secret.png',
            String.raw`\\server\share\proof.png`,
        ]) {
            const parsed = parseSessionMediaMessageMeta({
                happierDirectMedia: {
                    kind: 'direct_session_media.v1',
                    payload: {
                        media: [{
                            role: 'output',
                            category: 'generated',
                            mediaKind: 'image',
                            name: 'proof.png',
                            path,
                            mimeType: 'image/png',
                            sizeBytes: 0,
                        }],
                    },
                },
            }, { allowTrustedDirectMedia: true });

            expect(parsed.inlineImages).toEqual([]);
        }
    });
});
