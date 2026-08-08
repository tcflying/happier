import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  parseWindowsScheduledTaskStatusPowerShellJson,
  renderWindowsScheduledTaskWrapperPs1,
} from './windows';

describe('Windows scheduled task PowerShell status helper', () => {
  it('parses launch post-mortem fields from invariant JSON', () => {
    const parsed = parseWindowsScheduledTaskStatusPowerShellJson(JSON.stringify({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    }));

    expect(parsed).toEqual({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });
  });

  it('queries launch post-mortem fields using culture-independent property names', () => {
    const command = buildReadWindowsScheduledTaskStatusPowerShellCommand({
      taskPath: '\\Happier\\',
      taskName: 'happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTaskInfo');
    expect(command).toContain('LastTaskResult');
    expect(command).toContain('LastRunTime');
    expect(command).toContain('Actions');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('keeps setup fail-fast while returning the scheduled program exit code', () => {
    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: 'C:\\Users\\test\\.happier\\self-host',
      programArgs: ['C:\\Users\\test\\.happier\\self-host\\bin\\happier-server.exe', '--port', '3005'],
      env: { PORT: '3005' },
    });

    expect(wrapper).toContain('$ErrorActionPreference = "Stop"');
    expect(wrapper).toContain('$ErrorActionPreference = "Continue"');
    expect(wrapper).toContain('exit $LASTEXITCODE');
    expect(wrapper.indexOf('$ErrorActionPreference = "Stop"')).toBeLessThan(wrapper.indexOf('$ErrorActionPreference = "Continue"'));
    expect(wrapper.indexOf('$ErrorActionPreference = "Continue"')).toBeLessThan(wrapper.indexOf('& "C:\\Users\\test\\.happier\\self-host\\bin\\happier-server.exe"'));
  });

  it.runIf(process.platform === 'win32')('returns the real native child exit code and maps launch failures to exit 1', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'happier-schtasks-wrapper-'));
    try {
      const wrapperPath = join(tmp, 'service.ps1');
      writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
        programArgs: [process.execPath, '-e', 'process.exit(7)'],
      }), 'utf8');
      const childExit = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', wrapperPath,
      ]);
      expect(childExit.status).toBe(7);

      writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
        programArgs: [join(tmp, 'missing-service.exe')],
      }), 'utf8');
      const launchFailure = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', wrapperPath,
      ]);
      expect(launchFailure.status).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
