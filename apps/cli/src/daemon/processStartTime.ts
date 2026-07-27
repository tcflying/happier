import { spawnSync } from 'node:child_process';

const WINDOWS_PROCESS_START_TIME_SCRIPT =
  "(Get-Process -Id ([int]$args[0]) -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')";
const WINDOWS_PROCESS_COMMAND_SCRIPT =
  "(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$args[0]) -ErrorAction Stop).CommandLine";

export type ProcessStartTimeReader = (pid: number) => Promise<number | null> | number | null;
export type ProcessCommandIdentityReader =
  (pid: number) => Promise<string | null> | string | null;

export function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = platform === 'win32'
      ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_PROCESS_START_TIME_SCRIPT,
          String(pid),
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2_000,
          shell: false,
        },
      )
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        shell: false,
      });
    if (result.status !== 0) return null;
    const parsed = Date.parse(String(result.stdout ?? '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

export function readProcessCommandIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = platform === 'win32'
      ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_PROCESS_COMMAND_SCRIPT,
          String(pid),
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2_000,
          shell: false,
        },
      )
      : spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        shell: false,
      });
    if (result.status !== 0) return null;
    const command = String(result.stdout ?? '').trim();
    return command || null;
  } catch {
    return null;
  }
}
