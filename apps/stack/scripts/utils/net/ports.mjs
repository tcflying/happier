import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { resolveCommandPath } from '../proc/commands.mjs';
import { runCapture } from '../proc/proc.mjs';

export async function isTcpPortListening(port, { host = '127.0.0.1', timeoutMs = 250 } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let socket;
    try {
      socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        done(true);
      });
    } catch {
      done(false);
      return;
    }

    socket.unref();
    socket.on('error', () => done(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done(true);
    });
  });
}

function parseListenPidOutput(raw) {
  return Array.from(
    new Set(
      String(raw ?? '')
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 1)
    )
  );
}

export function parseWindowsNetstatListenPids(raw, port) {
  const targetPort = Number(port);
  const pids = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP' || fields[3].toUpperCase() !== 'LISTENING') continue;
    const endpoint = fields[1] ?? '';
    const separator = endpoint.lastIndexOf(':');
    const endpointPort = Number(endpoint.slice(separator + 1));
    const pid = Number(fields[4]);
    if (endpointPort === targetPort && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

export async function listListenPidsWithStatus(
  port,
  {
    timeoutMs = 1000,
    platform = process.platform,
    resolveCommandPathImpl = resolveCommandPath,
    runCaptureImpl = runCapture,
  } = {}
) {
  if (!Number.isFinite(port) || port <= 0) {
    return { supported: true, pids: [] };
  }
  if (platform === 'win32') {
    let resolved = '';
    try {
      resolved = await resolveCommandPathImpl('netstat', { timeoutMs });
    } catch {
      return { supported: false, pids: [], reason: 'listener-discovery-error' };
    }
    if (!resolved) {
      return { supported: false, pids: [], reason: 'listener-discovery-error' };
    }

    try {
      const raw = await runCaptureImpl(resolved, ['-ano', '-p', 'tcp'], { timeoutMs });
      return { supported: true, pids: parseWindowsNetstatListenPids(raw, port) };
    } catch {
      return { supported: false, pids: [], reason: 'listener-discovery-error' };
    }
  }

  const candidates = platform === 'darwin' ? ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof'] : ['lsof'];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveCommandPathImpl(candidate, { timeoutMs }).catch(() => '');
    if (!resolved) continue;

    let raw = '';
    try {
      // `lsof` exits non-zero if no matches; normalize to empty output.
      // eslint-disable-next-line no-await-in-loop
      raw = await runCaptureImpl(resolved, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs });
    } catch {
      raw = '';
    }
    return { supported: true, pids: parseListenPidOutput(raw) };
  }

  return { supported: false, pids: [], reason: 'missing-listener-discovery-command' };
}

export async function listListenPids(port, options = {}) {
  const out = await listListenPidsWithStatus(port, options);
  return out.pids;
}

/**
 * Best-effort: kill any processes LISTENing on a TCP port.
 * Used to avoid EADDRINUSE when a previous run left a server behind.
 */
export async function killPortListeners(port, { label = 'port' } = {}) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  if (process.platform === 'win32') {
    return [];
  }

  const pids = await listListenPids(port, { timeoutMs: 1000 });

  if (!pids.length) {
    return [];
  }

  // eslint-disable-next-line no-console
  console.log(`[local] ${label}: freeing tcp:${port} (killing pids: ${pids.join(', ')})`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await delay(500);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // not running / no permission
    }
  }

  return pids;
}

export async function isTcpPortFree(port, { host = '127.0.0.1', timeoutMs = 250 } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  // Prefer lsof-based detection to catch IPv6 listeners (e.g. TCP *:8081 (LISTEN))
  // which can make a "bind 127.0.0.1" probe incorrectly report "free" on macOS.
  const pids = await listListenPids(port, { timeoutMs });
  if (pids.length) return false;

  // Fallback: attempt to bind.
  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeoutId;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolvePromise(result);
    };

    let srv;
    try {
      srv = net.createServer((socket) => {
        // Tests use this as a port reservation primitive too; if something external connects
        // (e.g. a browser tab), immediately close the socket so server.close() cannot hang
        // waiting for long-lived connections to drain.
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    } catch {
      done(false);
      return;
    }

    srv.unref();

    timeoutId = setTimeout(() => {
      try {
        srv.close();
      } catch {
        // ignore
      }
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done(false);
    }, timeoutMs);

    srv.on('error', () => done(false));
    try {
      srv.listen({ port, host }, () => {
        try {
          srv.close(() => done(true));
        } catch {
          done(false);
        }
      });
    } catch {
      done(false);
    }
  });
}

export async function waitForTcpPortFree(
  port,
  { host = '127.0.0.1', timeoutMs = 5_000, intervalMs = 100, isTcpPortFreeImpl = isTcpPortFree } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await isTcpPortFreeImpl(port, { host, timeoutMs: Math.min(intervalMs, 250) })) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs);
  }
  return false;
}

export async function pickNextFreeTcpPort(startPort, { reservedPorts = new Set(), host = '127.0.0.1', tries = 200 } = {}) {
  let port = startPort;
  for (let i = 0; i < tries; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (!reservedPorts.has(port) && (await isTcpPortFree(port, { host }))) {
      return port;
    }
    port += 1;
  }
  throw new Error(`[local] unable to find a free TCP port starting at ${startPort}`);
}
