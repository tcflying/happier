import { describe, expect, it } from 'vitest';

import {
    formatUnknownToolInputText,
    formatUnknownToolResultText,
    formatUnknownToolSubtitle,
    resolveUnknownToolResultText,
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

    it('flattens text and input_text input blocks in the detail panel', () => {
        expect(formatUnknownToolInputText([
            { type: 'text', text: 'first ' },
            { type: 'input_text', text: 'second' },
        ])).toBe('first second');
    });

    it('flattens Codex input_text result blocks instead of rendering an empty body', () => {
        expect(formatUnknownToolResultText([
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: 'STREAM-1\nSTREAM-2\n' },
        ])).toBe('Script completed\nSTREAM-1\nSTREAM-2\n');
    });

    it.each(['running', 'completed', 'error'])('keeps non-empty output content while an unknown tool is %s', (state) => {
        const result = { stdout: `${state}-output` };
        expect(shouldShowUnknownToolResult({ state, result })).toBe(true);
        expect(resolveUnknownToolResultText({ state, result }, 'no output')).toBe(`${state}-output`);
    });

    it.each(['running', 'completed', 'error'])('uses non-empty fallback content for a blank %s result', (state) => {
        expect(resolveUnknownToolResultText({ state, result: '   \n' }, 'no output')).toBe('no output');
    });

    it('treats blank result text as absent content', () => {
        expect(formatUnknownToolResultText('   \n')).toBeNull();
        expect(formatUnknownToolResultText([{ type: 'text', text: '  ' }])).toBeNull();
    });

    it('summarizes objects without disclosing nested sensitive fields', () => {
        const payload = { token: 'do-not-render', nested: { password: 'do-not-render' } };
        expect(formatUnknownToolInputText(payload)).toBe('[object]');
        expect(formatUnknownToolResultText(payload)).toBe('[object]');
        expect(formatUnknownToolSubtitle(payload)).toBe('');
    });

    it('keeps explicit nested error or details messages visible without exposing sibling fields', () => {
        expect(formatUnknownToolResultText({
            error: { message: 'command failed', token: 'do-not-render' },
        })).toBe('command failed');
        expect(formatUnknownToolResultText({
            details: { message: 'tool timed out', token: 'do-not-render' },
        })).toBe('tool timed out');
    });
});
