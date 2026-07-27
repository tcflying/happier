function statusOf(dimension) {
  const status = String(dimension?.status ?? '').trim();
  if (status) return status;
  return dimension?.ok === true ? 'ready' : 'unknown';
}

export function renderWindowsStackSupervisorStatusText(snapshot) {
  const state = snapshot?.state ?? null;
  const dimensions = state?.health?.dimensions ?? {};
  const sessionRunner = dimensions.sessionRunner ?? {};
  const runnerCounts =
    Number.isFinite(Number(sessionRunner.tracked)) && Number.isFinite(Number(sessionRunner.live))
      ? ` (live=${Number(sessionRunner.live)}/${Number(sessionRunner.tracked)})`
      : '';

  return [
    `supervisor: ${snapshot?.running === true ? 'running' : 'stopped'}`,
    `phase: ${String(state?.phase ?? 'unknown')}`,
    `supervisor pid: ${Number(state?.supervisorPid) > 1 ? Number(state.supervisorPid) : 'unknown'}`,
    `stack pid: ${Number(state?.childPid) > 1 ? Number(state.childPid) : 'unknown'}`,
    `restart count: ${Number.isFinite(Number(state?.restartCount)) ? Number(state.restartCount) : 0}`,
    `last update: ${String(state?.updatedAt ?? 'unknown')}`,
    `relay: ${statusOf(dimensions.relay)}`,
    `UI: ${statusOf(dimensions.ui)}`,
    `RPC: ${statusOf(dimensions.rpc)}`,
    `daemon auth: ${statusOf(dimensions.daemonAuth)}`,
    `machine registration: ${statusOf(dimensions.machineRegistration)}`,
    `session runner: ${statusOf(sessionRunner)}${runnerCounts}`,
  ].join('\n');
}
