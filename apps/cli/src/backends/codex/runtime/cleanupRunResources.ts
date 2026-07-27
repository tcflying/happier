import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexMcpClient } from '@/backends/codex/codexMcpClient';
import {
  type SessionRunnerLifecycleAttempt,
} from '@/daemon/sessionRunnerLifecycleRuntime';
import type { SessionRunnerCleanupOutcome } from '@/daemon/sessionRunnerLock';

type CodexResettableRuntime = Readonly<{
  reset: () => Promise<void>;
}>;

type CleanupRunResourcesOptions = Readonly<{
  session: ApiSessionClient;
  reconnectionHandle: { cancel: () => void } | null;
  client: CodexMcpClient | null;
  codexRuntime: CodexResettableRuntime | null;
  stopHappierMcpServer: () => void;
  unmountRemoteUi: () => Promise<void>;
  keepAliveInterval: ReturnType<typeof setInterval>;
  messageBuffer: MessageBuffer;
  logDebug: (message: string, error?: unknown) => void;
  logActiveHandles: (tag: string) => void;
  cleanupBudgetMs?: number;
  onCleanupStart?: (deadlineAtMs: number, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
  onCleanupOutcome?: (outcome: SessionRunnerCleanupOutcome, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
}>;

type CleanupStageResult = 'completed' | 'failed' | 'timed_out';

export async function cleanupCodexRunResources(opts: CleanupRunResourcesOptions): Promise<void> {
  const cleanupBudgetMs = Math.max(1, Math.floor(opts.cleanupBudgetMs ?? 15_000));
  const onCleanupStart = opts.onCleanupStart;
  const onCleanupOutcome = opts.onCleanupOutcome;
  const deadlineAtMs = Date.now() + cleanupBudgetMs;
  const forceReserveMs = Math.min(5_000, Math.max(1, Math.floor(cleanupBudgetMs / 2)));
  const gracefulDeadlineAtMs = deadlineAtMs - forceReserveMs;
  let outcome: SessionRunnerCleanupOutcome = 'completed';
  let forceFinalizerConfirmed = true;
  const recordStageResult = (result: CleanupStageResult): void => {
    if (result === 'timed_out') {
      outcome = 'timed_out';
    } else if (result === 'failed' && outcome === 'completed') {
      outcome = 'failed';
    }
  };
  const runStage = async (
    operation: (attempt: SessionRunnerLifecycleAttempt) => Promise<void>,
    stageDeadlineAtMs: number,
  ): Promise<CleanupStageResult> => {
    type AttemptState = 'active' | 'committed' | 'expired' | 'settled';
    let attemptState: AttemptState = 'active';
    const attempt: SessionRunnerLifecycleAttempt = {
      isActive: () => attemptState === 'active' || attemptState === 'committed',
      tryCommit: () => {
        if (attemptState === 'active') {
          attemptState = 'committed';
          return true;
        }
        return attemptState === 'committed';
      },
    };
    const remainingMs = stageDeadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      attemptState = 'expired';
      return 'timed_out';
    }
    const operationPromise = Promise.resolve().then(() => operation(attempt));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timed_out'>((resolve) => {
      timer = setTimeout(() => {
        if (attemptState !== 'active') return;
        attemptState = 'expired';
        resolve('timed_out');
      }, remainingMs);
    });
    const completed = operationPromise.then(
      () => 'completed' as const,
      () => 'failed' as const,
    );
    const result = await Promise.race([completed, timedOut]);
    if (result !== 'timed_out') attemptState = 'settled';
    if (timer) clearTimeout(timer);
    return result;
  };
  const runForceStage = async (operation: () => Promise<void>): Promise<void> => {
    const result = await runStage(operation, deadlineAtMs);
    recordStageResult(result);
    if (result !== 'completed') forceFinalizerConfirmed = false;
  };

  opts.logDebug('[codex]: Final cleanup start');
  opts.logActiveHandles('cleanup-start');
  if (onCleanupStart) {
    const lifecycleStartResult = await runStage(
      async (attempt) => await onCleanupStart(deadlineAtMs, attempt),
      gracefulDeadlineAtMs,
    );
    if (lifecycleStartResult === 'timed_out') {
      recordStageResult(lifecycleStartResult);
      opts.logDebug('[codex]: Runner cleanup lifecycle start timed out; continuing cleanup');
    } else if (lifecycleStartResult === 'failed') {
      recordStageResult(lifecycleStartResult);
      opts.logDebug('[codex]: Failed to mark runner cleanup lifecycle; continuing cleanup');
    }
  }
  try {
    if (opts.reconnectionHandle) {
      opts.logDebug('[codex]: Cancelling offline reconnection');
      try {
        opts.reconnectionHandle.cancel();
      } catch (error) {
        recordStageResult('failed');
        opts.logDebug('[codex]: Failed to cancel offline reconnection', error);
      }
    }

    try {
      opts.logDebug('[codex]: sendSessionDeath');
      opts.session.sendSessionDeath();
    } catch (e) {
      recordStageResult('failed');
      opts.logDebug('[codex]: Error while notifying session death', e);
    }

    opts.logDebug('[codex]: flush begin');
    const flushResult = await runStage(async () => await opts.session.flush(), gracefulDeadlineAtMs);
    recordStageResult(flushResult);
    opts.logDebug(`[codex]: flush ${flushResult}`);

    // Force finalization always runs, even after a graceful stage rejects or
    // consumes its budget. All stages share the same absolute cleanup deadline.
    opts.logDebug('[codex]: session.close begin');
    await runForceStage(async () => await opts.session.close());
    opts.logDebug('[codex]: session.close finalizer done');

    if (opts.client) {
      opts.logDebug('[codex]: client.forceCloseSession begin');
      await runForceStage(async () => await opts.client!.forceCloseSession());
      opts.logDebug('[codex]: client.forceCloseSession finalizer done');
    }
    if (opts.codexRuntime) {
      opts.logDebug('[codex]: codexRuntime.reset begin');
      await runForceStage(async () => await opts.codexRuntime!.reset());
      opts.logDebug('[codex]: codexRuntime.reset finalizer done');
    }

    opts.logDebug('[codex]: unmountRemoteUi begin');
    await runForceStage(opts.unmountRemoteUi);
    opts.logDebug('[codex]: unmountRemoteUi finalizer done');
  } finally {
    try {
      opts.stopHappierMcpServer();
    } catch (error) {
      forceFinalizerConfirmed = false;
      recordStageResult('failed');
      opts.logDebug('[codex]: Failed to stop Happier MCP server', error);
    }
    try {
      opts.logDebug('[codex]: clearInterval(keepAlive)');
      clearInterval(opts.keepAliveInterval);
      opts.messageBuffer.clear();
    } catch (error) {
      forceFinalizerConfirmed = false;
      recordStageResult('failed');
      opts.logDebug('[codex]: Failed to clear final run resources', error);
    }
    opts.logActiveHandles('cleanup-end');
    opts.logDebug(`[codex]: Final cleanup ${outcome}; forceFinalizerConfirmed=${forceFinalizerConfirmed}`);
    if (forceFinalizerConfirmed && onCleanupOutcome) {
      const lifecycleOutcomeResult = await runStage(
        async (attempt) => await onCleanupOutcome(outcome, attempt),
        deadlineAtMs,
      );
      if (lifecycleOutcomeResult !== 'completed') {
        opts.logDebug(`[codex]: Runner cleanup lifecycle outcome ${lifecycleOutcomeResult}; cleanup will exit fail-closed`);
      }
    }
  }
}
