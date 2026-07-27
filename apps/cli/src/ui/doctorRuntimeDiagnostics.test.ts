import { join, normalize } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDoctorRuntimeDiagnostics,
  formatDoctorRuntimeLabel,
  formatDoctorSpawnPathLabel,
} from './doctorRuntimeDiagnostics';

describe('doctorRuntimeDiagnostics', () => {
  it('treats compiled bun bundles as embedded binaries instead of missing wrapper files', () => {
    const exists = vi.fn(() => false);

    const diagnostics = buildDoctorRuntimeDiagnostics({
      runtime: 'bun',
      processVersion: 'v24.3.0',
      bunVersion: '1.2.23',
      nodeVersion: '24.3.0',
      projectRoot: '/$bunfs',
      exists,
    });

    expect(diagnostics).toMatchObject({
      runtime: 'bun',
      runtimeVersion: '1.2.23',
      nodeCompatibilityVersion: 'v24.3.0',
      isEmbeddedBundle: true,
      wrapperPath: null,
      cliEntrypointPath: null,
      wrapperExists: null,
      cliEntrypointExists: null,
    });
    expect(exists).not.toHaveBeenCalled();
    expect(formatDoctorRuntimeLabel(diagnostics)).toBe('Bun 1.2.23 (embedded binary)');
    expect(formatDoctorSpawnPathLabel(diagnostics.wrapperPath)).toBe('embedded in binary');
  });

  it('reports node source installs with concrete wrapper paths', () => {
    const projectRoot = normalize('/repo/apps/cli');
    const wrapperPath = normalize(join(projectRoot, 'bin', 'happier.mjs'));
    const cliEntrypointPath = normalize(join(projectRoot, 'dist', 'index.mjs'));
    const exists = vi.fn((path: string) => normalize(path) === wrapperPath);

    const diagnostics = buildDoctorRuntimeDiagnostics({
      runtime: 'node',
      processVersion: 'v22.14.0',
      bunVersion: null,
      nodeVersion: '22.14.0',
      projectRoot,
      exists,
    });

    expect(diagnostics).toMatchObject({
      runtime: 'node',
      runtimeVersion: 'v22.14.0',
      nodeCompatibilityVersion: 'v22.14.0',
      isEmbeddedBundle: false,
      wrapperPath,
      cliEntrypointPath,
      wrapperExists: true,
      cliEntrypointExists: false,
    });
    expect(formatDoctorRuntimeLabel(diagnostics)).toBe('Node.js v22.14.0');
    expect(formatDoctorSpawnPathLabel(diagnostics.cliEntrypointPath)).toBe(cliEntrypointPath);
  });
});
