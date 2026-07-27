import { z } from 'zod';

import { sanitizeBugReportUrl } from '../bugReports/sanitize.js';

const NonEmptyString = z.string().trim().min(1);
const PublicReleaseChannelLabelSchema = z.enum(['stable', 'preview', 'dev']);
const HappierInstallationSourceSchema = z.enum([
  'firstPartyManaged',
  'selfHostManaged',
  'stackManaged',
  'fromSource',
  'npmGlobal',
  'pathBinary',
  'unknown',
]);
const HappierServicePlatformSchema = z.enum(['darwin', 'linux', 'win32']);
const HappierServiceBackendSchema = z.enum([
  'launchd',
  'systemd-user',
  'systemd-system',
  'schtasks-user',
  'schtasks-system',
]);
const HappierServiceVerificationSchema = z.enum(['verified', 'candidate']);
const HappierServiceTargetModeSchema = z.enum(['pinned', 'default-following']);
const HappierWarningSeveritySchema = z.enum(['info', 'warning', 'error']);

function sanitizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

export const DoctorSnapshotServerProfileSchema = z.object({
  id: NonEmptyString,
  name: NonEmptyString,
  serverUrl: NonEmptyString,
  publicServerUrl: NonEmptyString.optional(),
  webappUrl: NonEmptyString,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number(),
});

export type DoctorSnapshotServerProfile = z.infer<typeof DoctorSnapshotServerProfileSchema>;

export const DoctorSnapshotDaemonStatusSchema = z.object({
  server: z.object({
    activeServerId: NonEmptyString,
    serverUrl: NonEmptyString,
    localServerUrl: NonEmptyString.nullable(),
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
    comparableKey: NonEmptyString.nullable(),
  }),
  daemon: z.object({
    running: z.boolean(),
    pid: z.number().int().positive().nullable(),
    httpPort: z.number().int().positive().nullable(),
    startedWithCliVersion: NonEmptyString.optional(),
    startedWithPublicReleaseChannel: PublicReleaseChannelLabelSchema.nullable().optional(),
    runtimeId: NonEmptyString.optional(),
    startupSource: NonEmptyString.optional(),
    serviceManaged: z.boolean().nullable().optional(),
    serviceLabel: NonEmptyString.nullable().optional(),
  }),
  service: z.object({
    installed: z.boolean(),
    running: z.boolean(),
  }),
  auth: z.object({
    authenticated: z.boolean(),
    machineRegistered: z.boolean(),
    machineId: NonEmptyString.nullable(),
    needsAuth: z.boolean(),
    accountId: NonEmptyString.nullable(),
  }),
});

export type DoctorSnapshotDaemonStatus = z.infer<typeof DoctorSnapshotDaemonStatusSchema>;

export const HappierDoctorActiveInvocationSchema = z.object({
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  invokerName: NonEmptyString.nullable(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  installationId: NonEmptyString.nullable(),
});

export const HappierDoctorInstallationSchema = z.object({
  id: NonEmptyString,
  source: HappierInstallationSourceSchema,
  components: z.array(NonEmptyString).min(1),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  version: NonEmptyString.nullable(),
  path: NonEmptyString,
  realPath: NonEmptyString.nullable(),
  shimName: NonEmptyString.nullable(),
  onPath: z.boolean(),
  managedRoot: NonEmptyString.nullable(),
});

export const HappierDoctorInstallationInventorySchema = z.object({
  activeInvocation: HappierDoctorActiveInvocationSchema.nullable(),
  installations: z.array(HappierDoctorInstallationSchema),
});

export const HappierDoctorServiceSchema = z.object({
  id: NonEmptyString,
  serviceType: NonEmptyString,
  platform: HappierServicePlatformSchema,
  backend: HappierServiceBackendSchema,
  label: NonEmptyString,
  verification: HappierServiceVerificationSchema,
  targetMode: HappierServiceTargetModeSchema.optional(),
  ring: PublicReleaseChannelLabelSchema.nullable(),
  instanceId: NonEmptyString.nullable(),
  scope: z.enum(['user', 'system']),
  definitionPath: NonEmptyString,
  executablePath: NonEmptyString.nullable(),
  serverUrl: NonEmptyString.nullable().optional(),
  publicServerUrl: NonEmptyString.nullable().optional(),
  installed: z.boolean(),
  running: z.boolean(),
  configuredCliVersion: NonEmptyString.nullable().optional(),
  runningCliVersion: NonEmptyString.nullable().optional(),
});

export const HappierDoctorServiceInventorySchema = z.object({
  services: z.array(HappierDoctorServiceSchema),
});

export const HappierDoctorRelaySchema = z.object({
  id: NonEmptyString,
  ring: PublicReleaseChannelLabelSchema,
  scope: z.enum(['user', 'system']),
  installed: z.boolean(),
  version: NonEmptyString.nullable(),
  relayUrl: NonEmptyString,
  healthy: z.boolean().nullable(),
  serviceActive: z.boolean().nullable(),
  serviceEnabled: z.boolean().nullable(),
  warnings: z.array(NonEmptyString).optional(),
});

export const HappierDoctorRelayInventorySchema = z.object({
  relays: z.array(HappierDoctorRelaySchema),
});

export const HappierDoctorWarningSchema = z.object({
  code: NonEmptyString,
  severity: HappierWarningSeveritySchema,
  message: NonEmptyString,
  repairCommands: z.array(NonEmptyString),
});

const RunnerDiagnosticContextSchema = z.object({
  machineId: NonEmptyString.nullable(),
  sessionId: NonEmptyString,
  pid: z.number().int().positive(),
  generationId: NonEmptyString.nullable(),
  processState: z.enum(['dead', 'servable', 'stopped', 'zombie']),
  lastHeartbeatAtMs: z.number().nonnegative().nullable(),
  cleanupPhase: z.enum(['running', 'cleanup', 'finished', 'unknown']),
  recoveryRecommendation: NonEmptyString,
});

export const DoctorRuntimeDiagnosticSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('inactive_session_runner_lock'),
    severity: z.literal('warning'),
    data: RunnerDiagnosticContextSchema.extend({
      lockState: z.enum(['live', 'stale', 'unknown']),
    }),
  }),
  z.object({
    code: z.literal('runner_cleanup_overdue'),
    severity: z.literal('warning'),
    data: RunnerDiagnosticContextSchema.extend({
      deadlineAtMs: z.number().nonnegative(),
      overdueByMs: z.number().nonnegative(),
    }),
  }),
  z.object({
    code: z.literal('runner_heartbeat_stale'),
    severity: z.literal('warning'),
    data: RunnerDiagnosticContextSchema.extend({
      heartbeatState: z.enum(['stale', 'missing']),
      heartbeatAgeMs: z.number().nonnegative().nullable(),
    }),
  }),
  z.object({
    code: z.literal('runner_log_stale'),
    severity: z.literal('warning'),
    data: RunnerDiagnosticContextSchema.extend({
      logState: z.enum(['stale', 'missing']),
      fileName: NonEmptyString.nullable(),
      lastLogWriteAtMs: z.number().nonnegative().nullable(),
      logAgeMs: z.number().nonnegative().nullable(),
    }),
  }),
  z.object({
    code: z.literal('session_mutation_dead_letter'),
    severity: z.literal('warning'),
    data: z.object({
      machineId: NonEmptyString.nullable(),
      fileName: NonEmptyString,
      sessionIds: z.array(NonEmptyString),
      entryCount: z.number().int().positive(),
      recoveryRecommendation: NonEmptyString,
    }),
  }),
  z.object({
    code: z.literal('runner_cli_build_drift'),
    severity: z.literal('warning'),
    data: RunnerDiagnosticContextSchema.extend({
      runnerCliVersion: NonEmptyString,
      currentCliVersion: NonEmptyString,
      runnerBuildId: NonEmptyString.nullable(),
      currentRunnerBuildId: NonEmptyString.nullable(),
    }),
  }),
  z.object({
    code: z.literal('server_webapp_role_port_drift'),
    severity: z.enum(['warning', 'error']),
    data: z.object({
      serverId: NonEmptyString,
      resolvedServerUrl: NonEmptyString,
      resolvedWebappUrl: NonEmptyString,
      profileServerUrl: NonEmptyString,
      profileLocalServerUrl: NonEmptyString.nullable().optional(),
      profileWebappUrl: NonEmptyString,
      driftKinds: z.array(z.enum(['role', 'port', 'same_endpoint'])).min(1),
      recoveryRecommendation: NonEmptyString,
    }),
  }),
]);

export type DoctorRuntimeDiagnostic = z.infer<typeof DoctorRuntimeDiagnosticSchema>;

export const DoctorSnapshotSchema = z.object({
  capturedAt: NonEmptyString,
  server: z.object({
    activeServerId: NonEmptyString,
    serverUrl: NonEmptyString,
    publicServerUrl: NonEmptyString,
    webappUrl: NonEmptyString,
  }),
  accountId: NonEmptyString.nullable(),
  settings: z.object({
    activeServerId: NonEmptyString.nullable(),
    servers: z.array(DoctorSnapshotServerProfileSchema),
    knownAccountIds: z.array(NonEmptyString),
  }),
  daemonStatus: DoctorSnapshotDaemonStatusSchema.optional(),
  installations: z.object({
    happier: HappierDoctorInstallationInventorySchema.optional(),
  }).optional(),
  services: z.object({
    happier: HappierDoctorServiceInventorySchema.optional(),
  }).optional(),
  relays: z.object({
    happier: HappierDoctorRelayInventorySchema.optional(),
  }).optional(),
  warnings: z.array(HappierDoctorWarningSchema).optional(),
  runtimeDiagnostics: z.array(DoctorRuntimeDiagnosticSchema).optional(),
});

export type DoctorSnapshot = z.infer<typeof DoctorSnapshotSchema>;

export function sanitizeDoctorSnapshotUrls(snapshot: DoctorSnapshot): DoctorSnapshot {
  return {
    ...snapshot,
    server: {
      ...snapshot.server,
      serverUrl: sanitizeUrl(snapshot.server.serverUrl),
      publicServerUrl: sanitizeUrl(snapshot.server.publicServerUrl),
      webappUrl: sanitizeUrl(snapshot.server.webappUrl),
    },
    settings: {
      ...snapshot.settings,
      servers: snapshot.settings.servers.map((entry) => ({
        ...entry,
        serverUrl: sanitizeUrl(entry.serverUrl),
        publicServerUrl: entry.publicServerUrl ? sanitizeUrl(entry.publicServerUrl) : undefined,
        webappUrl: sanitizeUrl(entry.webappUrl),
      })),
    },
    installations: snapshot.installations
      ? {
          ...snapshot.installations,
          happier: snapshot.installations.happier
            ? {
                ...snapshot.installations.happier,
                activeInvocation: snapshot.installations.happier.activeInvocation
                  ? {
                      ...snapshot.installations.happier.activeInvocation,
                      path: sanitizeUrl(snapshot.installations.happier.activeInvocation.path),
                      realPath: snapshot.installations.happier.activeInvocation.realPath
                        ? sanitizeUrl(snapshot.installations.happier.activeInvocation.realPath)
                        : null,
                    }
                  : null,
                installations: snapshot.installations.happier.installations.map((entry) => ({
                  ...entry,
                  path: sanitizeUrl(entry.path),
                  realPath: entry.realPath ? sanitizeUrl(entry.realPath) : null,
                })),
              }
            : undefined,
        }
      : undefined,
    daemonStatus: snapshot.daemonStatus
      ? {
          ...snapshot.daemonStatus,
          server: {
            ...snapshot.daemonStatus.server,
            serverUrl: sanitizeUrl(snapshot.daemonStatus.server.serverUrl),
            localServerUrl: snapshot.daemonStatus.server.localServerUrl
              ? sanitizeUrl(snapshot.daemonStatus.server.localServerUrl)
              : null,
            publicServerUrl: sanitizeUrl(snapshot.daemonStatus.server.publicServerUrl),
            webappUrl: sanitizeUrl(snapshot.daemonStatus.server.webappUrl),
          },
        }
      : undefined,
    services: snapshot.services
      ? {
          ...snapshot.services,
          happier: snapshot.services.happier
            ? {
                ...snapshot.services.happier,
                services: snapshot.services.happier.services.map((entry) => ({
                  ...entry,
                  serverUrl: entry.serverUrl ? sanitizeUrl(entry.serverUrl) : entry.serverUrl,
                  publicServerUrl: entry.publicServerUrl ? sanitizeUrl(entry.publicServerUrl) : entry.publicServerUrl,
                })),
              }
            : undefined,
        }
      : undefined,
    relays: snapshot.relays
      ? {
          ...snapshot.relays,
          happier: snapshot.relays.happier
            ? {
                ...snapshot.relays.happier,
                relays: snapshot.relays.happier.relays.map((entry) => ({
                  ...entry,
                  relayUrl: sanitizeUrl(entry.relayUrl),
                  warnings: entry.warnings?.map((warning) => sanitizeUrl(warning)),
                })),
              }
            : undefined,
        }
      : undefined,
    runtimeDiagnostics: snapshot.runtimeDiagnostics?.map((finding) => (
      finding.code === 'server_webapp_role_port_drift'
        ? {
            ...finding,
            data: {
              ...finding.data,
              resolvedServerUrl: sanitizeUrl(finding.data.resolvedServerUrl),
              resolvedWebappUrl: sanitizeUrl(finding.data.resolvedWebappUrl),
              profileServerUrl: sanitizeUrl(finding.data.profileServerUrl),
              profileLocalServerUrl: finding.data.profileLocalServerUrl
                ? sanitizeUrl(finding.data.profileLocalServerUrl)
                : finding.data.profileLocalServerUrl,
              profileWebappUrl: sanitizeUrl(finding.data.profileWebappUrl),
            },
          }
        : finding
    )),
  };
}

export function parseDoctorSnapshotSafe(raw: string): { ok: true; snapshot: DoctorSnapshot } | { ok: false; error: string } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Missing doctor snapshot JSON' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  const result = DoctorSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: 'Invalid doctor snapshot schema' };
  }

  return { ok: true, snapshot: sanitizeDoctorSnapshotUrls(result.data) };
}
