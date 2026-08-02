import { describe, expect, it } from 'vitest';

import {
    formatUnknownToolInputText,
    formatUnknownToolResultText,
    formatUnknownToolSubtitle,
    shouldShowUnknownToolResult,
} from './unknownToolContent';

describe('unknownToolContent', () => {
    it('keeps string tool input visible when expanded to summary', () => {
        expect(formatUnknownToolSubtitle('const r = await tools.shell_command({ command: "pwd" });'))
            .toContain('tools.shell_command');
    });

    it('renders full string tool input without JSON quotes in the detail panel', () => {
        const input = 'const r = await tools.shell_command({ command: "pwd" });';
        expect(formatUnknownToolInputText(input)).toBe(input);
    });

    it('flattens Codex input_text result blocks instead of rendering an empty body', () => {
        expect(formatUnknownToolResultText([
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: 'STREAM-1\nSTREAM-2\n' },
        ])).toBe('Script completed\nSTREAM-1\nSTREAM-2\n');
    });

    it('shows partial output while an unknown tool is still running', () => {
        expect(shouldShowUnknownToolResult({ state: 'running', result: { stdout: 'STREAM-1\n' } })).toBe(true);
    });

    it('keeps a failed tool result visible for diagnosis', () => {
        expect(shouldShowUnknownToolResult({ state: 'error', result: { error: 'failed' } })).toBe(true);
    });
});
