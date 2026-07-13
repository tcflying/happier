import { runCapture } from './proc.mjs';

const PROCESS_SNAPSHOT_SCRIPT = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
const PROCESS_IDENTITY_SNAPSHOT_SCRIPT = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress';

function parseSnapshotRows(raw) {
  const records = JSON.parse(raw);
  return Array.isArray(records) ? records : [records];
}

export async function readWindowsProcessParents({ runCaptureImpl = runCapture, timeoutMs = 2000 } = {}) {
  const raw = await runCaptureImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT],
    { timeoutMs },
  );
  const rows = parseSnapshotRows(raw);
  return new Map(rows.flatMap((row) => {
    const pid = Number(row?.ProcessId);
    const parentPid = Number(row?.ParentProcessId);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0
      ? [[pid, parentPid]]
      : [];
  }));
}

export async function readWindowsProcessIdentity(
  pid,
  { runCaptureImpl = runCapture, timeoutMs = 2000 } = {},
) {
  const expectedPid = Number(pid);
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) return null;

  try {
    const raw = await runCaptureImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_IDENTITY_SNAPSHOT_SCRIPT],
      { timeoutMs },
    );
    const row = parseSnapshotRows(raw).find((candidate) => Number(candidate?.ProcessId) === expectedPid);
    const creationDate = String(row?.CreationDate ?? '').trim();
    return creationDate ? { pid: expectedPid, creationDate } : null;
  } catch {
    return null;
  }
}

export async function isWindowsPidDescendantOf(
  candidatePid,
  ancestorPid,
  { readParentsImpl = readWindowsProcessParents } = {},
) {
  const candidate = Number(candidatePid);
  const ancestor = Number(ancestorPid);
  if (!Number.isInteger(candidate) || candidate <= 0 || !Number.isInteger(ancestor) || ancestor <= 0) return false;

  let parents;
  try {
    parents = await readParentsImpl();
  } catch {
    return false;
  }
  if (!(parents instanceof Map) || parents.size === 0) return false;

  const visited = new Set();
  let current = candidate;
  for (let steps = 0; steps < parents.size; steps += 1) {
    if (visited.has(current)) return false;
    visited.add(current);

    const parent = parents.get(current);
    if (!Number.isInteger(parent) || parent <= 0) return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}
