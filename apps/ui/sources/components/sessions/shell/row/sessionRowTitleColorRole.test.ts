import { describe, expect, it } from 'vitest';

import { resolveSessionRowTitleColorRole } from './sessionRowTitleColorRole';

describe('resolveSessionRowTitleColorRole', () => {
    it('keeps every non-selected title secondary regardless of activity', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'activityAndAttention',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('secondary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'activityAndAttention',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'working',
            titleTone: 'emphasized',
        })).toBe('secondary');
    });

    it('does not turn attention-state titles primary unless selected', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'working',
            titleTone: 'emphasized',
        })).toBe('secondary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'permission_required',
            titleTone: 'emphasized',
        })).toBe('secondary');
    });

    it('does not turn active session titles primary unless selected', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('secondary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: true,
            isSessionActive: false,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('secondary');
    });

    it('keeps selected rows primary and disconnected rows secondary', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: true,
            isConnected: false,
            isSessionActive: false,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('primary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: false,
            isSessionActive: true,
            attentionState: 'permission_required',
            titleTone: 'emphasized',
        })).toBe('secondary');
    });
});
