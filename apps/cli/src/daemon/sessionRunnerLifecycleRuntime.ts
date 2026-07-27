import type { SessionRunnerCleanupOutcome } from './sessionRunnerLock';

export type SessionRunnerLifecycleAttempt = Readonly<{
  isActive: () => boolean;
  tryCommit: () => boolean;
}>;

type SessionRunnerCleanupLifecycleController = Readonly<{
  begin: (deadlineAtMs: number, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
  finish: (outcome: SessionRunnerCleanupOutcome, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
}>;

let activeController: SessionRunnerCleanupLifecycleController | null = null;

export function registerSessionRunnerCleanupLifecycle(
  controller: SessionRunnerCleanupLifecycleController,
): () => void {
  activeController = controller;
  return () => {
    if (activeController === controller) activeController = null;
  };
}

export async function beginRegisteredSessionRunnerCleanup(
  deadlineAtMs: number,
  attempt?: SessionRunnerLifecycleAttempt,
): Promise<void> {
  await activeController?.begin(deadlineAtMs, attempt);
}

export async function finishRegisteredSessionRunnerCleanup(
  outcome: SessionRunnerCleanupOutcome,
  attempt?: SessionRunnerLifecycleAttempt,
): Promise<void> {
  await activeController?.finish(outcome, attempt);
}
