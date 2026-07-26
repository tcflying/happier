import type { SessionRunnerCleanupOutcome } from './sessionRunnerLock';

type SessionRunnerCleanupLifecycleController = Readonly<{
  begin: (budgetMs: number) => Promise<void>;
  finish: (outcome: SessionRunnerCleanupOutcome) => Promise<void>;
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

export async function beginRegisteredSessionRunnerCleanup(budgetMs: number): Promise<void> {
  await activeController?.begin(budgetMs);
}

export async function finishRegisteredSessionRunnerCleanup(
  outcome: SessionRunnerCleanupOutcome,
): Promise<void> {
  await activeController?.finish(outcome);
}
