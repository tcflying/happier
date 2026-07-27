/**
 * Vitest runs executable `.mjs` files through Vite before evaluating them.
 * Node accepts an initial shebang, while Vite's transform parser does not.
 * Keep this test-only adapter in the harness so shipped executable scripts
 * retain the shebang needed for direct invocation.
 */
export const vitestMjsShebangPlugin = {
  name: 'happier-vitest-strip-mjs-shebang',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | null {
    const moduleId = id.split('?', 1)[0] ?? id;
    if (!moduleId.endsWith('.mjs') || !code.startsWith('#!')) return null;
    return code.replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  },
};
