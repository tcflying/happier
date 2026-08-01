import type { SessionRowAttentionState, SessionRowTitleTone } from './resolveSessionRowPresentation';

export type SessionListActiveColorModeV1 =
    | 'activityAndAttention'
    | 'attentionOnly'
    | 'allActive';

export type SessionRowTitleColorRole = 'primary' | 'secondary';

export function normalizeSessionListActiveColorMode(value: unknown): SessionListActiveColorModeV1 {
    return value === 'attentionOnly' || value === 'allActive'
        ? value
        : 'activityAndAttention';
}

export function resolveSessionRowTitleColorRole(input: Readonly<{
    mode: SessionListActiveColorModeV1;
    selected: boolean;
    isConnected: boolean;
    isSessionActive: boolean;
    attentionState: SessionRowAttentionState;
    titleTone: SessionRowTitleTone;
}>): SessionRowTitleColorRole {
    return input.selected ? 'primary' : 'secondary';
}
