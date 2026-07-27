function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function safeMachineId(raw) {
  const value = String(raw ?? '').trim();
  return value || null;
}

async function probeHttp({ url, kind, fetchImpl, timeoutMs }) {
  if (!url) return { ok: false, status: 'not_configured', url: null };
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    const statusOk = response.status >= 200 && response.status < 400;
    const contentOk = kind !== 'ui' || contentType.includes('text/html');
    return {
      ok: statusOk && contentOk,
      status: statusOk && contentOk ? 'ready' : contentOk ? `http_${response.status}` : 'invalid_content_type',
      url,
    };
  } catch {
    return { ok: false, status: 'unreachable', url };
  }
}

export async function collectWindowsStackHealth({
  relayUrl,
  uiUrl,
  fetchImpl = fetch,
  readDaemonStatus,
  readDaemonControlState,
  postDaemonControl,
  isPidAliveImpl,
  timeoutMs = 3_000,
} = {}) {
  for (const [name, fn] of Object.entries({
    fetchImpl,
    readDaemonStatus,
    readDaemonControlState,
    postDaemonControl,
    isPidAliveImpl,
  })) {
    if (typeof fn !== 'function') throw new Error(`[service health] ${name} is required`);
  }

  const relayHealthUrl = `${normalizeBaseUrl(relayUrl)}/health`;
  const uiHealthUrl = `${normalizeBaseUrl(uiUrl)}/`;
  const [relay, ui, daemonStatus, daemonControlState] = await Promise.all([
    probeHttp({ url: relayHealthUrl, kind: 'relay', fetchImpl, timeoutMs }),
    probeHttp({ url: uiHealthUrl, kind: 'ui', fetchImpl, timeoutMs }),
    readDaemonStatus().catch(() => null),
    readDaemonControlState().catch(() => null),
  ]);

  const daemonPid = Number(daemonStatus?.daemon?.pid ?? daemonControlState?.pid);
  const httpPort = Number(daemonStatus?.daemon?.httpPort ?? daemonControlState?.httpPort);
  const daemonRunning =
    daemonStatus?.daemon?.running === true &&
    Number.isFinite(daemonPid) &&
    daemonPid > 1 &&
    isPidAliveImpl(daemonPid);
  const authenticated = daemonStatus?.auth?.authenticated === true;
  const machineRegistered = daemonStatus?.auth?.machineRegistered === true;
  const machineId = safeMachineId(daemonStatus?.auth?.machineId);

  let rpc = {
    ok: false,
    status: daemonRunning ? 'unreachable' : 'daemon_not_running',
    daemonPid: Number.isFinite(daemonPid) && daemonPid > 1 ? daemonPid : null,
    httpPort: Number.isFinite(httpPort) && httpPort > 0 ? httpPort : null,
  };
  let runnerPayload = null;
  if (daemonRunning && Number.isFinite(httpPort) && httpPort > 0 && daemonControlState) {
    const ping = await postDaemonControl({
      path: '/ping',
      state: daemonControlState,
      timeoutMs,
    }).catch(() => null);
    if (ping?.status === 'ok') {
      rpc = { ok: true, status: 'ready', daemonPid, httpPort };
      runnerPayload = await postDaemonControl({
        path: '/list',
        state: daemonControlState,
        timeoutMs,
      }).catch(() => null);
    }
  }

  const children = Array.isArray(runnerPayload?.children) ? runnerPayload.children : [];
  const normalizedChildren = children
    .map((child) => ({
      sessionId: String(child?.happySessionId ?? '').trim(),
      pid: Number(child?.pid),
    }))
    .filter((child) => child.sessionId && Number.isFinite(child.pid) && child.pid > 1);
  const staleSessionIds = normalizedChildren
    .filter((child) => !isPidAliveImpl(child.pid))
    .map((child) => child.sessionId);
  const sessionRunner = rpc.ok && runnerPayload
    ? {
        ok: staleSessionIds.length === 0,
        status: staleSessionIds.length === 0 ? 'ready' : 'stale_runner',
        tracked: normalizedChildren.length,
        live: normalizedChildren.length - staleSessionIds.length,
        staleSessionIds,
      }
    : {
        ok: false,
        status: rpc.ok ? 'list_unavailable' : 'rpc_unavailable',
        tracked: 0,
        live: 0,
        staleSessionIds: [],
      };

  const dimensions = {
    relay,
    ui,
    rpc,
    daemonAuth: {
      ok: authenticated,
      status: authenticated ? 'authenticated' : 'auth_required',
    },
    machineRegistration: {
      ok: machineRegistered,
      status: machineRegistered ? 'registered' : 'registration_required',
      machineId,
    },
    sessionRunner,
  };

  const blocked = relay.ok && ui.ok && (!authenticated || !machineRegistered);
  const restartable =
    !relay.ok ||
    !ui.ok ||
    (authenticated && !rpc.ok) ||
    (rpc.ok && !sessionRunner.ok);
  const allHealthy = Object.values(dimensions).every((dimension) => dimension.ok === true);

  return {
    status: allHealthy ? 'healthy' : blocked && !restartable ? 'blocked' : restartable ? 'unhealthy' : 'degraded',
    restartable,
    dimensions,
  };
}
