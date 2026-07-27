import { describe, expect, it } from 'vitest';

import { vitestMjsShebangPlugin } from './vitestMjsShebangPlugin';

describe('vitestMjsShebangPlugin', () => {
  it('strips only an initial mjs shebang, including Windows line endings', () => {
    expect(vitestMjsShebangPlugin.transform('#!/usr/bin/env node\r\nexport const value = 1;\r\n', '/repo/script.mjs')).toBe(
      'export const value = 1;\r\n',
    );
  });

  it('leaves non-mjs modules and non-initial shebang text unchanged', () => {
    expect(vitestMjsShebangPlugin.transform('#!/usr/bin/env node\nexport const value = 1;\n', '/repo/script.ts')).toBeNull();
    expect(vitestMjsShebangPlugin.transform('export const text = "#!";\n', '/repo/script.mjs')).toBeNull();
  });
});
