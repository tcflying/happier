/**
 * Session runner respawn scheduling for the daemon.
 *
 * This is responsible for restarting session runner processes after unexpected termination,
 * while ensuring stop requests never trigger restart loops.
 */

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';

import { RestartController } from '@/subprocess/supervision/restartController';
import type { StopRequest, TerminationEvent } from '@/subprocess/supervision/types';

export type DaemonChildExit = Readonly<{ reason: string; code: number | null; signal: string | null }>;

export type SessionRunnerRespawnManager = Readonly<{
  markStopRequested: (sessionId: string, request: StopRequest) => void;
  clearStopRequested: (sessionId: string) => void;
  handleUnexpectedExit: (
    trackedSession: TrackedSession,
    exit: DaemonChildExit,
    options?: Readonly<{ forceRestart?: boolean }>,
  ) => boolean;
}>;

export type SessionRunnerRespawnOptionsResolver = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

export type SessionRunnerRespawnTerminalReason =
  | 'already_running'
  | 'stop_requested'
  | 'missing_spawn_options'
  | 'directory_approval_required'
  | 'not_authenticated'
  | 'no_restart';

function normalizeSessionId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeOptionalString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isNotAuthenticatedSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as { code?: unknown; error?: unknown; errorCode?: unknown; errorMessage?: unknown };
  return (
    value.code === 'not_authenticated' ||
    value.error === 'not_authenticated' ||
    value.errorCode === 'not_authenticated' ||
    value.errorMessage === 'not_authenticated'
  );
}

function toTerminationEvent(exit: DaemonChildExit): TerminationEvent {
  if (typeof exit.signal === 'string' && exit.signal.trim().length > 0) {
    return { type: 'signaled', signal: exit.signal as NodeJS.Signals };
  }
  if (typeof exit.code === 'number' && Number.isFinite(exit.code)) {
    return { type: 'exited', code: Math.max(0, Math.trunc(exit.code)) };
  }
  if (exit.reason === 'process-missing' || exit.reason === 'process-reused') return { type: 'missing' };
  if (exit.reason === 'process-error') {
    return { type: 'spawn_error', errorName: 'Error', errorMessage: 'process-error' };
  }
  return { type: 'exited', code: 1 };
}

const connectedServiceRestartRequestedTerminationEvent: TerminationEvent = {
  type: 'spawn_error',
  errorName: 'ConnectedServiceRestartRequested',
  errorMessage: 'connected_service_auth_group_restart_requested',
};

function buildRespawnOptions(params: Readonly<{
  spawnOptions: SpawnSessionOptions;
  sessionId: string;
  vendorResumeId: string;
}>): SpawnSessionOptions {
  const resumeFromOptions = normalizeOptionalString(params.spawnOptions.resume);
  const resumeFromTracked = normalizeOptionalString(params.vendorResumeId);
  const effectiveResume = resumeFromOptions || resumeFromTracked;
  const { resume: _resume, ...spawnOptionsWithoutResume } = params.spawnOptions;
  return {
    ...spawnOptionsWithoutResume,
    ...(effectiveResume ? { resume: effectiveResume } : {}),
    existingSessionId: params.sessionId,
    sessionId: undefined,
    approvedNewDirectoryCreation: true,
  };
}

export function createSessionRunnerRespawnManager(params: Readonly<{
  enabled: boolean;
  maxRestarts: number | null;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  isSessionAlreadyRunning: (sessionId: string) => boolean | Promise<boolean>;
  spawnSession: (opts: SpawnSessionOptions) => Promise<unknown>;
  stopSpawnedSession?: (input: Readonly<{ sessionId: string; result: unknown }>) => boolean | Promise<boolean>;
  resolveRespawnOptions?: SessionRunnerRespawnOptionsResolver;
  onRespawnSuccess?: (input: Readonly<{
    sessionId: string;
    previousPid: number;
    result: unknown;
  }>) => void;
  onRespawnTerminal?: (input: Readonly<{
    sessionId: string;
    previousPid: number;
    reason: SessionRunnerRespawnTerminalReason;
    detail?: string;
  }>) => void;
  random: () => number;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string) => void;
}>): SessionRunnerRespawnManager {
  const stopRequestedBySessionId = new Map<string, StopRequest>();
  const stateBySessionId = new Map<
    string,
    Readonly<{ controller: RestartController; timer: NodeJS.Timeout | null; previousPid: number | null }>
  >();

  const getOrCreateController = (sessionId: string): RestartController => {
    const existing = stateBySessionId.get(sessionId);
    if (existing) return existing.controller;

    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: params.maxRestarts,
        baseDelayMs: params.baseDelayMs,
        maxDelayMs: params.maxDelayMs,
        jitterMs: params.jitterMs,
      },
      { random: params.random },
    );

    const stopRequest = stopRequestedBySessionId.get(sessionId);
    if (stopRequest) controller.markStopRequested(stopRequest);

    stateBySessionId.set(sessionId, { controller, timer: null, previousPid: null });
    return controller;
  };

  const clearTimer = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing?.timer) return;
    clearTimeout(existing.timer);
    stateBySessionId.set(sessionId, {
      controller: existing.controller,
      timer: null,
      previousPid: existing.previousPid,
    });
  };

  const scheduleRetryFromTermination = (
    sessionId: string,
    spawnOptions: SpawnSessionOptions,
    vendorResumeId: string,
    event: TerminationEvent,
    previousPid: number,
  ) => {
    const state = stateBySessionId.get(sessionId);
    if (!state) return;

    const decision = state.controller.nextDecisionForTermination(event);
    if (decision.type === 'no_restart') {
      if (decision.reason.startsWith('max_restarts_exceeded')) {
        params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
      }
      stateBySessionId.delete(sessionId);
      params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'no_restart', detail: decision.reason });
      return;
    }

    scheduleSpawn(sessionId, spawnOptions, vendorResumeId, decision.delayMs, decision.attempt, event, previousPid);
  };

  const scheduleSpawn = (
    sessionId: string,
    spawnOptions: SpawnSessionOptions,
    vendorResumeId: string,
    delayMs: number,
    attempt: number,
    event: TerminationEvent,
    previousPid: number,
  ) => {
    clearTimer(sessionId);
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;

    const timer = setTimeout(() => {
      void (async () => {
        const scheduled = stateBySessionId.get(sessionId);
        if (!scheduled) return;
        stateBySessionId.set(sessionId, {
          controller: scheduled.controller,
          timer: null,
          previousPid,
        });
        const alreadyRunning = await params.isSessionAlreadyRunning(sessionId);
        if (alreadyRunning) {
          stateBySessionId.delete(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'already_running' });
          return;
        }
        const stopRequest = stopRequestedBySessionId.get(sessionId);
        if (stopRequest) {
          stateBySessionId.delete(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'stop_requested' });
          return;
        }

        const defaultOptions = buildRespawnOptions({ spawnOptions, sessionId, vendorResumeId });
        const respawnOptions = params.resolveRespawnOptions
          ? await params.resolveRespawnOptions({ sessionId, spawnOptions, vendorResumeId, defaultOptions })
          : defaultOptions;
        const stopRequestAfterResolve = stopRequestedBySessionId.get(sessionId);
        if (stopRequestAfterResolve) {
          stateBySessionId.delete(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'stop_requested' });
          return;
        }
        params.logDebug(
          `[DAEMON RUN] Respawning runner for session ${sessionId} after ${delayMs}ms (attempt ${attempt})`,
          { exit: event },
        );

        void params
          .spawnSession(respawnOptions)
          .then(async (result) => {
            if (result && typeof result === 'object' && (result as any).type === 'success') {
              if (stopRequestedBySessionId.has(sessionId)) {
                let replacementStopConfirmed = false;
                try {
                  replacementStopConfirmed = await params.stopSpawnedSession?.({ sessionId, result }) === true;
                } catch (error) {
                  params.logDebug(
                    `[DAEMON RUN] Failed to stop replacement spawned after cancellation for session ${sessionId}`,
                    error,
                  );
                }
                if (!replacementStopConfirmed) {
                  params.logWarn(
                    `[DAEMON RUN] Retaining runtime ownership for session ${sessionId}; replacement stop was not confirmed`,
                  );
                  return;
                }
                stateBySessionId.delete(sessionId);
                params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'stop_requested' });
                return;
              }
              params.onRespawnSuccess?.({ sessionId, previousPid, result });
              stateBySessionId.delete(sessionId);
              return;
            }

            if (result && typeof result === 'object' && (result as any).type === 'requestToApproveDirectoryCreation') {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (directory approval required)`);
              stateBySessionId.delete(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'directory_approval_required' });
              return;
            }

            if (isNotAuthenticatedSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (auth:not_authenticated)`);
              stateBySessionId.delete(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'not_authenticated' });
              return;
            }

            params.logDebug(`[DAEMON RUN] Respawn attempt returned non-success for session ${sessionId}`, result);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: 'Error',
              errorMessage:
                result && typeof result === 'object' && typeof (result as any).errorCode === 'string'
                  ? `respawn_failed:${String((result as any).errorCode)}`
                  : 'respawn_failed',
            };
            scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
          })
          .catch((error) => {
            params.logDebug(`[DAEMON RUN] Failed to respawn runner for session ${sessionId}`, error);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: error instanceof Error ? error.name : 'Error',
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
          });
      })().catch((error) => {
        params.logDebug(`[DAEMON RUN] Failed to evaluate respawn preflight for session ${sessionId}`, error);
        const retryEvent: TerminationEvent = {
          type: 'spawn_error',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
      });
    }, delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
    stateBySessionId.set(sessionId, {
      controller: existing.controller,
      timer: timer as any,
      previousPid,
    });
  };

  return {
    markStopRequested: (sessionIdRaw: string, request: StopRequest) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      if (!sessionId) return;
      stopRequestedBySessionId.set(sessionId, request);
      const existing = stateBySessionId.get(sessionId);
      if (existing) {
        existing.controller.markStopRequested(request);
        if (existing.timer) {
          clearTimeout(existing.timer);
          stateBySessionId.delete(sessionId);
          if (existing.previousPid !== null) {
            params.onRespawnTerminal?.({
              sessionId,
              previousPid: existing.previousPid,
              reason: 'stop_requested',
            });
          }
        }
      }
    },
    clearStopRequested: (sessionIdRaw: string) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      if (!sessionId) return;
      stopRequestedBySessionId.delete(sessionId);
      const existing = stateBySessionId.get(sessionId);
      if (existing) {
        existing.controller.clearStopRequested();
      }
    },
    handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit, options) => {
      if (!params.enabled && options?.forceRestart !== true) return false;
      if (trackedSession.startedBy !== 'daemon') return false;
      const sessionId = normalizeSessionId(trackedSession.happySessionId);
      if (!sessionId) return false;
      const forceRestart = options?.forceRestart === true;
      if (forceRestart) {
        // A connected-service-initiated forced restart explicitly supersedes any prior stop request
        // (e.g. a stale flag left by an earlier manual stop that the resume path never cleared --
        // `clearStopRequested` has no production caller). Without this, the forced kill's respawn is
        // silently vetoed and the session dies, surfaced to the user as an exit-143 crash. Clearing
        // here makes the manager map, a freshly-created controller, and the scheduled-spawn re-check
        // all treat this as the intentional restart it is.
        stopRequestedBySessionId.delete(sessionId);
        stateBySessionId.get(sessionId)?.controller.clearStopRequested();
      }
      const stopRequest = stopRequestedBySessionId.get(sessionId);
      if (stopRequest) return false;

      const spawnOptions = trackedSession.spawnOptions;
      if (!spawnOptions || typeof (spawnOptions as any).directory !== 'string' || !String((spawnOptions as any).directory).trim()) {
        if (forceRestart) {
          params.onRespawnTerminal?.({ sessionId, previousPid: trackedSession.pid, reason: 'missing_spawn_options' });
        }
        return false;
      }

      const vendorResumeId = normalizeOptionalString(trackedSession.vendorResumeId);
      const controller = getOrCreateController(sessionId);
      const event = forceRestart ? connectedServiceRestartRequestedTerminationEvent : toTerminationEvent(exit);
      const decision = controller.nextDecisionForTermination(event);
      if (decision.type === 'no_restart') {
        if (decision.reason.startsWith('max_restarts_exceeded')) {
          params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
        }
        stateBySessionId.delete(sessionId);
        params.onRespawnTerminal?.({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'no_restart',
          detail: decision.reason,
        });
        return false;
      }

      scheduleSpawn(
        sessionId,
        spawnOptions,
        vendorResumeId,
        forceRestart ? 0 : decision.delayMs,
        decision.attempt,
        event,
        trackedSession.pid,
      );
      return true;
    },
  };
}
