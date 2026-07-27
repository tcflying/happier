import type { SessionRunnerCleanupOutcome } from './sessionRunnerLock';

export type SessionRunnerLifecycleAttempt = Readonly<{
  isActive: () => boolean;
  tryCommit: () => boolean;
}>;

export type SessionRunnerCleanupLifecycle = Readonly<{
  begin: (deadlineAtMs: number, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
  finish: (outcome: SessionRunnerCleanupOutcome, attempt?: SessionRunnerLifecycleAttempt) => Promise<void>;
}>;
