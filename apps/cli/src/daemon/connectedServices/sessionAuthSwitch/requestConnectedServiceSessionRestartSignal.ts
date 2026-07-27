export type ConnectedServiceDaemonRestartTrigger =
  | 'manual_switch'
  | 'automatic_group_switch'
  | 'refresh_triggered_restart'
  | 'runtime_auth_recovery_restart'
  | 'usage_limit_recovery'
  | 'reconnect_propagation'
  | 'cli_version_migration';

export type ConnectedServiceDaemonRestartDiagnosticStatus =
  | 'requested'
  | 'process_already_missing'
  | 'signal_failed'
  | 'skipped_stale_owner';

export type ConnectedServiceSessionRestartSignalResult = Readonly<{
  status: 'requested' | 'process_already_missing' | 'skipped_stale_owner';
}>;

export type ConnectedServiceDaemonRestartDiagnosticInput = Readonly<{
  trigger: ConnectedServiceDaemonRestartTrigger;
  sessionId?: string | null;
  agentId?: string | null;
  serviceId?: string | null;
  profileId?: string | null;
  groupId?: string | null;
  generation?: number | null;
  reason?: string | null;
}>;

export type ConnectedServiceDaemonRestartDiagnosticRecord = Readonly<{
  type: 'connected_service_daemon_restart';
  trigger: ConnectedServiceDaemonRestartTrigger;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  sessionId: string | null;
  agentId: string | null;
  serviceId: string | null;
  profileId: string | null;
  groupId: string | null;
  generation: number | null;
  reason: string | null;
  pid: number | null;
  processGroupPid: number | null;
  delayMs: number | null;
  atMs: number;
}>;

export type ConnectedServiceDaemonRestartDiagnosticRecorder = (
  record: ConnectedServiceDaemonRestartDiagnosticRecord,
) => void;

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function buildConnectedServiceDaemonRestartDiagnosticRecord(input: Readonly<{
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  pid?: number | null;
  processGroupPid?: number | null;
  delayMs?: number | null;
  atMs: number;
}>): ConnectedServiceDaemonRestartDiagnosticRecord {
  return {
    type: 'connected_service_daemon_restart',
    trigger: input.diagnostic.trigger,
    status: input.status,
    sessionId: normalizeString(input.diagnostic.sessionId),
    agentId: normalizeString(input.diagnostic.agentId),
    serviceId: normalizeString(input.diagnostic.serviceId),
    profileId: normalizeString(input.diagnostic.profileId),
    groupId: normalizeString(input.diagnostic.groupId),
    generation: normalizeNumber(input.diagnostic.generation),
    reason: normalizeString(input.diagnostic.reason),
    pid: normalizeNumber(input.pid),
    processGroupPid: normalizeNumber(input.processGroupPid),
    delayMs: normalizeNumber(input.delayMs),
    atMs: Math.trunc(input.atMs),
  };
}

export function recordConnectedServiceDaemonRestartDiagnostic(input: Readonly<{
  diagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
  status: ConnectedServiceDaemonRestartDiagnosticStatus;
  pid?: number | null;
  processGroupPid?: number | null;
  delayMs?: number | null;
  nowMs: () => number;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
}>): void {
  input.recordRestartDiagnostic?.(buildConnectedServiceDaemonRestartDiagnosticRecord({
    diagnostic: input.diagnostic,
    status: input.status,
    pid: input.pid ?? null,
    processGroupPid: input.processGroupPid ?? null,
    delayMs: input.delayMs ?? null,
    atMs: input.nowMs(),
  }));
}

export function isConnectedServiceRestartSignalStaleProcessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ESRCH') return true;
  return /\bESRCH\b|\bno such process\b/i.test(error.message);
}

export async function requestConnectedServiceSessionRestartSignal(params: Readonly<{
  pid: number;
  processGroupPid?: number | null;
  delayMs: number;
  shouldSignal?: () => boolean;
  onSignalFailure: (error: unknown) => void;
  onProcessAlreadyMissing?: () => void;
  restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
  nowMs?: () => number;
}>): Promise<ConnectedServiceSessionRestartSignalResult> {
  const nowMs = params.nowMs ?? Date.now;
  const recordDiagnostic = (status: ConnectedServiceDaemonRestartDiagnosticStatus) => {
    if (!params.restartDiagnostic) return;
    recordConnectedServiceDaemonRestartDiagnostic({
      diagnostic: params.restartDiagnostic,
      status,
      pid: params.pid,
      processGroupPid: params.processGroupPid ?? null,
      delayMs: params.delayMs,
      nowMs,
      recordRestartDiagnostic: params.recordRestartDiagnostic,
    });
  };

  const signal = (): ConnectedServiceSessionRestartSignalResult => {
    if (params.shouldSignal && !params.shouldSignal()) {
      recordDiagnostic('skipped_stale_owner');
      return { status: 'skipped_stale_owner' };
    }
    recordDiagnostic('requested');
    if (
      typeof params.processGroupPid === 'number' &&
      Number.isInteger(params.processGroupPid) &&
      params.processGroupPid > 0
    ) {
      try {
        process.kill(-params.processGroupPid, 'SIGTERM');
        return { status: 'requested' };
      } catch {
        // Fall back to the tracked process below. Some platforms do not support process groups.
      }
    }
    try {
      process.kill(params.pid, 'SIGTERM');
      return { status: 'requested' };
    } catch (error) {
      if (isConnectedServiceRestartSignalStaleProcessError(error)) {
        recordDiagnostic('process_already_missing');
        params.onProcessAlreadyMissing?.();
        return { status: 'process_already_missing' };
      }
      recordDiagnostic('signal_failed');
      params.onSignalFailure(error);
      throw error;
    }
  };

  if (params.delayMs <= 0) {
    return signal();
  }

  return await new Promise<ConnectedServiceSessionRestartSignalResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(signal());
      } catch (error) {
        reject(error);
      }
    }, params.delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
  });
}
