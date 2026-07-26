import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexMcpClient } from '@/backends/codex/codexMcpClient';
import {
  beginRegisteredSessionRunnerCleanup,
  finishRegisteredSessionRunnerCleanup,
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
  onCleanupStart?: (budgetMs: number) => Promise<void>;
  onCleanupOutcome?: (outcome: SessionRunnerCleanupOutcome) => Promise<void>;
}>;

export async function cleanupCodexRunResources(opts: CleanupRunResourcesOptions): Promise<void> {
  const cleanupBudgetMs = Math.max(1, Math.floor(opts.cleanupBudgetMs ?? 15_000));
  const onCleanupStart = opts.onCleanupStart ?? beginRegisteredSessionRunnerCleanup;
  const onCleanupOutcome = opts.onCleanupOutcome ?? finishRegisteredSessionRunnerCleanup;
  await onCleanupStart(cleanupBudgetMs);
  const deadlineAtMs = Date.now() + cleanupBudgetMs;
  let outcome: SessionRunnerCleanupOutcome = 'completed';
  const runWithinDeadline = async (operation: () => Promise<void>): Promise<boolean> => {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remainingMs);
    });
    const completed = operation().then(
      () => true as const,
      () => true as const,
    );
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  };

  opts.logDebug('[codex]: Final cleanup start');
  opts.logActiveHandles('cleanup-start');
  try {
    if (opts.reconnectionHandle) {
      opts.logDebug('[codex]: Cancelling offline reconnection');
      opts.reconnectionHandle.cancel();
    }

    try {
      opts.logDebug('[codex]: sendSessionDeath');
      opts.session.sendSessionDeath();
      opts.logDebug('[codex]: flush begin');
      if (!(await runWithinDeadline(async () => await opts.session.flush()))) {
        outcome = 'timed_out';
        return;
      }
      opts.logDebug('[codex]: flush done');
      opts.logDebug('[codex]: session.close begin');
      if (!(await runWithinDeadline(async () => await opts.session.close()))) {
        outcome = 'timed_out';
        return;
      }
      opts.logDebug('[codex]: session.close done');
    } catch (e) {
      opts.logDebug('[codex]: Error while closing session', e);
    }

    if (opts.client) {
      opts.logDebug('[codex]: client.forceCloseSession begin');
      if (!(await runWithinDeadline(async () => await opts.client!.forceCloseSession()))) {
        outcome = 'timed_out';
        return;
      }
      opts.logDebug('[codex]: client.forceCloseSession done');
    } else if (!(await runWithinDeadline(async () => await opts.codexRuntime?.reset()))) {
      outcome = 'timed_out';
      return;
    }

    if (!(await runWithinDeadline(opts.unmountRemoteUi))) {
      outcome = 'timed_out';
      return;
    }
  } finally {
    // Fence-safe synchronous force cleanup must run even if an async stage hangs.
    opts.stopHappierMcpServer();
    opts.logDebug('[codex]: clearInterval(keepAlive)');
    clearInterval(opts.keepAliveInterval);
    opts.messageBuffer.clear();
    opts.logActiveHandles('cleanup-end');
    opts.logDebug(outcome === 'completed' ? '[codex]: Final cleanup completed' : '[codex]: Final cleanup timed out');
    await onCleanupOutcome(outcome);
  }
}
