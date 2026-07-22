import type { ApiMachineClient } from '@/api/apiMachine';
import type { SessionRunnerRespawnTerminalReason } from '@/daemon/processSupervision/sessionRunnerRespawn';

export async function settleDirectSessionRespawnOwnership(input: Readonly<{
  apiMachine: Pick<
    ApiMachineClient,
    'claimDirectSessionRuntimeOwnership' | 'releaseDirectSessionRuntimeOwnership'
  > | null;
  sessionId: string;
  reason: SessionRunnerRespawnTerminalReason;
}>): Promise<'claimed' | 'released' | 'skipped'> {
  if (!input.apiMachine) return 'skipped';
  if (input.reason === 'already_running') {
    await input.apiMachine.claimDirectSessionRuntimeOwnership(input.sessionId);
    return 'claimed';
  }
  await input.apiMachine.releaseDirectSessionRuntimeOwnership(input.sessionId);
  return 'released';
}
