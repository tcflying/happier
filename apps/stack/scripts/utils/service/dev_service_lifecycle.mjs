export function shouldExitAlreadyRunningDevStack({
  serviceMode = false,
  restart = false,
  serverReady = false,
  daemonReady = false,
  expoReady = false,
} = {}) {
  return serviceMode !== true
    && restart !== true
    && serverReady === true
    && daemonReady === true
    && expoReady === true;
}
