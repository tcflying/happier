import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function resolveSessionRunnerBuildId(params: Readonly<{
  entryPath?: string;
}> = {}): Promise<string | null> {
  const entryPath = String(params.entryPath ?? process.argv[1] ?? '').trim();
  if (!entryPath) return null;
  try {
    const bytes = await readFile(resolve(entryPath));
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}
