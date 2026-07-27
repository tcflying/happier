export type ServerProfileUrlRoleConflict = Readonly<{
  code: 'server_webapp_same_relay_endpoint';
  conflictingRole: 'serverUrl' | 'localServerUrl';
  endpoint: string;
}>;

type ComparableLoopbackEndpoint = Readonly<{
  protocol: 'http:' | 'https:';
  port: string;
}>;

function isLoopbackHostname(hostnameRaw: string): boolean {
  const hostname = hostnameRaw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parseComparableLoopbackEndpoint(raw: string): ComparableLoopbackEndpoint | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isLoopbackHostname(url.hostname)) return null;
    return {
      protocol: url.protocol,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    };
  } catch {
    return null;
  }
}

function endpointsMatch(
  left: ComparableLoopbackEndpoint | null,
  right: ComparableLoopbackEndpoint | null,
): boolean {
  return Boolean(
    left
    && right
    && left.protocol === right.protocol
    && left.port === right.port,
  );
}

export function inspectServerProfileUrlRoles(params: Readonly<{
  serverUrl: string;
  localServerUrl?: string | null;
  webappUrl: string;
}>): ServerProfileUrlRoleConflict | null {
  const webappEndpoint = parseComparableLoopbackEndpoint(params.webappUrl);
  if (!webappEndpoint) return null;

  const candidates: ReadonlyArray<Readonly<{
    role: 'serverUrl' | 'localServerUrl';
    value: string | null | undefined;
  }>> = [
    { role: 'serverUrl', value: params.serverUrl },
    { role: 'localServerUrl', value: params.localServerUrl },
  ];

  for (const candidate of candidates) {
    const relayEndpoint = parseComparableLoopbackEndpoint(String(candidate.value ?? ''));
    if (!endpointsMatch(relayEndpoint, webappEndpoint)) continue;
    return {
      code: 'server_webapp_same_relay_endpoint',
      conflictingRole: candidate.role,
      endpoint: `${webappEndpoint.protocol}//loopback:${webappEndpoint.port}`,
    };
  }

  return null;
}

export class ServerProfileUrlRoleError extends Error {
  public readonly code = 'server_webapp_same_relay_endpoint' as const;
  public readonly conflictingRole: ServerProfileUrlRoleConflict['conflictingRole'];
  public readonly endpoint: string;

  public constructor(conflict: ServerProfileUrlRoleConflict) {
    super(
      `The web app URL cannot use the same local endpoint as ${conflict.conflictingRole} (${conflict.endpoint})`,
    );
    this.name = 'ServerProfileUrlRoleError';
    this.conflictingRole = conflict.conflictingRole;
    this.endpoint = conflict.endpoint;
  }
}

export function assertServerProfileUrlRoles(params: Readonly<{
  serverUrl: string;
  localServerUrl?: string | null;
  webappUrl: string;
}>): void {
  const conflict = inspectServerProfileUrlRoles(params);
  if (conflict) throw new ServerProfileUrlRoleError(conflict);
}
