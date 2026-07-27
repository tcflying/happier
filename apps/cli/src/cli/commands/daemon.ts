import chalk from 'chalk';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import {
  checkIfDaemonRunningAndCleanupStaleState,
  inspectDaemonRunningStateAndCleanupStaleState,
  listDaemonSessions,
  stopDaemon,
  stopDaemonSession,
} from '@/daemon/controlClient';
import { startDaemon } from '@/daemon/startDaemon';
import {
  resolveDaemonServiceInstallationSnapshotFromEnv,
  runDaemonServiceCliCommand,
} from '@/daemon/service/cli';
import { getLatestDaemonLog } from '@/ui/logger';
import { runDoctorCommand } from '@/ui/doctor';
import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { readCredentials } from '@/persistence';
import { resolveLaunchAgentPlistPath, resolveSystemdUserUnitPath } from '@/daemon/service/plan';
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { handleServiceRepairCliCommand } from './serviceRepair/handleServiceRepairCliCommand';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonOwnerConflict } from '@/daemon/ownership/renderDaemonOwnerConflict';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import {
  evaluateDaemonStartupServiceConflict,
  renderDaemonInstalledServiceConflict,
} from '@/daemon/ownership/daemonServiceInventory';
import {
  resolveDaemonStartupSourceFromEnv,
  isDaemonStartupSourceServiceManaged,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import type { CommandContext } from '@/cli/commandRegistry';

function printDaemonJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function flattenDaemonMessage(title: string, lines: readonly string[]): string {
  return [title, ...lines].join(' ').trim();
}

function isManualOrLegacyManualOwner(serviceManaged: boolean | null | undefined): boolean {
  return serviceManaged !== true;
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}

function shouldPrintDaemonHelp(args: readonly string[]): boolean {
  if (!args.slice(1).some(isHelpFlag)) return false;

  const daemonSubcommand = args[1];
  return daemonSubcommand !== 'service'
    && daemonSubcommand !== 'install'
    && daemonSubcommand !== 'uninstall';
}

function printDaemonHelp(): void {
  console.log(`
	${chalk.bold('happier daemon')} - Manage the local daemon

${chalk.bold('Usage:')}
  happier daemon start [--takeover]  Start the daemon (detached)
  happier daemon restart [--takeover]  Restart the daemon (stop -> start)
  happier daemon stop               Stop a manual daemon (sessions stay alive; use happier service stop for installed background services)
  happier daemon stop --kill-sessions  Stop a manual daemon and its tracked sessions
  happier daemon stop --all         Stop daemons for all configured relays
  happier daemon restart [--takeover]  Restart the daemon
  happier daemon restart --kill-sessions  Restart the daemon and its tracked sessions
  happier daemon restart --migrate-sessions  Restart, then respawn CLI-version-drifted runners
  happier daemon start-sync [--takeover]  Start the daemon synchronously
  happier daemon status             Show daemon status
  happier daemon status --all       Show daemon status for all configured relays
  happier daemon list               List active sessions
  happier daemon install            Enable automatic startup (legacy alias)
  happier daemon uninstall          Disable automatic startup (legacy alias)
	  happier service                   Manage automatic startup
	  happier service list              List installed background services
	  happier doctor repair             Preview or apply recommended automatic startup repair actions
	  happier service repair            Legacy alias for doctor repair
	  happier daemon service list       Legacy alias for service list
	  happier daemon service repair     Legacy alias for service repair

  Prefix with --server/--server-url to target a specific relay profile for this invocation.
  Example: happier --server company service install

  For installed background services, use happier service start|stop|restart.

  If you want to kill all happier related processes run
  ${chalk.cyan('happier doctor clean')}

${chalk.bold('Note:')} The daemon is the local Happier process on this computer. Automatic startup is provided by installed background services (\`happier service\`).

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('happier doctor clean')}
`);
}

function isChildProcessAlive(child: Readonly<{ pid?: number }>): boolean {
  if (!child.pid) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'service') {
    if (args[2] === 'repair') {
      await handleServiceRepairCliCommand({
        argv: args.slice(2),
        commandPath: 'happier doctor',
      });
      return;
    }
    await runDaemonServiceCliCommand({ argv: args.slice(2) });
    return;
  }

  if (shouldPrintDaemonHelp(args)) {
    printDaemonHelp();
    return;
  }

  if (daemonSubcommand === 'list') {
    try {
      const sessions = await listDaemonSessions();

      if (sessions.length === 0) {
        console.log(
          'No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)',
        );
      } else {
        console.log('Active sessions:');
        console.log(JSON.stringify(sessions, null, 2));
      }
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'stop-session') {
    const sessionId = args[2];
    if (!sessionId) {
      console.error('Session ID required');
      process.exit(1);
    }

    try {
      const success = await stopDaemonSession(sessionId);
      console.log(success ? 'Session stopped' : 'Failed to stop session');
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'start') {
    const jsonRequested = args.includes('--json');
    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverRequested = args.includes('--takeover');
    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (ownership.kind === 'compatible') {
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'already_running',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
        });
      } else {
        console.log('Daemon already running');
        console.log(`  Relay URL: ${configuration.serverUrl}`);
        console.log(`  Relay profile: ${configuration.activeServerId}`);
      }
      process.exit(0);
    }
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });

    if (takeoverDecision.kind === 'conflict') {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start',
        owner: takeoverDecision.owner,
      });
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'owner_conflict',
          message: flattenDaemonMessage(message.title, message.lines),
        });
      } else {
        console.error(message.title);
        for (const line of message.lines) {
          console.error(`  ${line}`);
        }
      }
      process.exit(1);
    }

    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-start',
          services: startupServiceConflict.services,
        });
        if (jsonRequested) {
          printDaemonJson({
            ok: false,
            error: 'installed_background_service_conflict',
            message: flattenDaemonMessage(message.title, message.lines),
          });
        } else {
          console.error(message.title);
          for (const line of message.lines) {
            console.error(line);
          }
        }
        process.exit(1);
      }
    }

    if (takeoverDecision.kind === 'manual-owner-takeover' && !jsonRequested) {
      console.error('Taking over the current manual daemon before starting another daemon...');
    }

    const child = await spawnDetachedDaemonStartSync(takeoverRequested
      ? {
        env: {
          ...process.env,
          HAPPIER_DAEMON_TAKEOVER: '1',
        },
      }
      : {});
    child.unref();

    const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 5000);
    const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', 100);
    const started = await waitForDaemonRunningWithinBudget({
      isRunning: () => checkIfDaemonRunningAndCleanupStaleState(),
      timeoutMs,
      pollMs,
    });

    if (started) {
      let account: string | undefined;
      try {
        const creds = await readCredentials();
        const payload = creds?.token ? decodeJwtPayload(creds.token) : null;
        const sub = typeof payload?.sub === 'string' ? payload.sub : '';
        if (sub) account = sub;
      } catch {
        // ignore
      }
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'started',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
          ...(account ? { account } : {}),
        });
      } else {
        console.log('Daemon started successfully');
        console.log(`  Relay URL: ${configuration.serverUrl}`);
        console.log(`  Relay profile: ${configuration.activeServerId}`);
        if (account) console.log(`  Account: ${account}`);
      }
    } else {
      const inspection = await inspectDaemonRunningStateAndCleanupStaleState().catch(() => ({ status: 'not-running' as const }));
      const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
      if (inspection.status === 'starting' || isChildProcessAlive(child)) {
        if (jsonRequested) {
          printDaemonJson({
            ok: true,
            status: 'starting',
            relay: configuration.serverUrl,
            relayId: configuration.activeServerId,
            ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
          });
        } else {
          console.log('Daemon is still starting in the background');
          console.log(`  Relay URL: ${configuration.serverUrl}`);
          console.log(`  Relay profile: ${configuration.activeServerId}`);
          if (latestDaemonLog?.path) {
            console.log(`  Latest daemon log: ${latestDaemonLog.path}`);
          }
        }
        process.exit(0);
      }

      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'start_failed',
          message: 'Failed to start daemon',
          ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
        });
      } else {
        console.error('Failed to start daemon');
        if (latestDaemonLog?.path) {
          console.error(`Latest daemon log: ${latestDaemonLog.path}`);
        }
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'start-sync') {
    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverRequested = args.includes('--takeover');
    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (ownership.kind === 'compatible') {
      console.log(chalk.green('Daemon already running'));
      console.log(`  Relay URL: ${configuration.serverUrl}`);
      console.log(`  Relay profile: ${configuration.activeServerId}`);
      process.exit(0);
    }
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });

    if (takeoverDecision.kind === 'conflict') {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start-sync',
        owner: takeoverDecision.owner,
      });
      console.error(message.title);
      for (const line of message.lines) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }

    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-start-sync',
          services: startupServiceConflict.services,
        });
        console.error(message.title);
        for (const line of message.lines) {
          console.error(line);
        }
        process.exit(1);
      }
    }

    if (takeoverDecision.kind === 'manual-owner-takeover') {
      console.error('Taking over the current manual daemon before starting another daemon...');
    }

    await startDaemon({ takeover: takeoverRequested });
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    const stopSessions = args.includes('--kill-sessions');
    if (args.includes('--all')) {
      await stopAllDaemonsBestEffort({ stopSessions });
      process.exit(0);
    }
    const ownership = await evaluateCurrentDaemonOwner();
    if (ownership.kind !== 'none' && !isManualOrLegacyManualOwner(ownership.owner.serviceManaged)) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-stop',
        owner: ownership.owner,
      });
      console.error(message.title);
      for (const line of message.lines) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }
    await stopDaemon({ stopSessions });
    process.exit(0);
  }

  if (daemonSubcommand === 'restart') {
    const jsonRequested = args.includes('--json');
    if (args.includes('--all')) {
      const message = '`happier daemon restart --all` is not supported yet.';
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'restart_all_unsupported',
          message,
        });
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverRequested = args.includes('--takeover');
    const takeoverAllowed = takeoverRequested
      && ownership.kind === 'conflict'
      && isManualOrLegacyManualOwner(ownership.owner.serviceManaged);
    if (ownership.kind === 'conflict' && !takeoverAllowed) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-restart',
        owner: ownership.owner,
      });
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'owner_conflict',
          message: flattenDaemonMessage(message.title, message.lines),
        });
      } else {
        console.error(message.title);
        for (const line of message.lines) {
          console.error(`  ${line}`);
        }
      }
      process.exit(1);
    }

    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-restart',
          services: startupServiceConflict.services,
        });
        if (jsonRequested) {
          printDaemonJson({
            ok: false,
            error: 'installed_background_service_conflict',
            message: flattenDaemonMessage(message.title, message.lines),
          });
        } else {
          console.error(message.title);
          for (const line of message.lines) {
            console.error(line);
          }
        }
        process.exit(1);
      }
    }

    if (takeoverAllowed && !jsonRequested) {
      const takeoverNotice = buildDaemonTakeoverNotice({ action: 'restart' });
      console.error(takeoverNotice.title);
      for (const line of takeoverNotice.lines) {
        console.error(`  ${line}`);
      }
    }

    const stopSessions = args.includes('--kill-sessions');
    const migrateSessions = args.includes('--migrate-sessions');
    const started = await restartDaemonAndWait({
      stopSessions,
      takeover: takeoverRequested,
      ...(migrateSessions ? { migrateSessions: true } : {}),
    });

    if (started) {
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'restarted',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
        });
      } else {
        console.log('Daemon restarted successfully');
        console.log(`  Relay URL: ${configuration.serverUrl}`);
        console.log(`  Relay profile: ${configuration.activeServerId}`);
      }
      process.exit(0);
    }

    const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
    if (jsonRequested) {
      printDaemonJson({
        ok: false,
        error: 'restart_failed',
        message: 'Failed to restart daemon',
        relay: configuration.serverUrl,
        relayId: configuration.activeServerId,
        ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
      });
    } else {
      console.error('Failed to restart daemon');
      if (latestDaemonLog?.path) {
        console.error(`Latest daemon log: ${latestDaemonLog.path}`);
      }
    }
    process.exit(1);
  }

  if (daemonSubcommand === 'status') {
      if (args.includes('--json')) {
      if (args.includes('--all')) {
        const statuses = await listDaemonStatusesForAllKnownServers();
        const activeRelayUrl = configuration.publicServerUrl || configuration.serverUrl;
        const activeComparableKey = (() => {
          try {
            return createServerUrlComparableKey(activeRelayUrl);
          } catch {
            return null;
          }
        })();
        process.stdout.write(`${JSON.stringify({
          active: {
            serverId: configuration.activeServerId,
            relayUrl: activeRelayUrl,
            comparableKey: activeComparableKey,
          },
          entries: statuses.map((entry) => {
            let servicePlatform = typeof entry.service.platform === 'string' ? entry.service.platform : null;
            let serviceInstalledPath = typeof entry.service.installedPath === 'string' ? entry.service.installedPath : null;
            if (!servicePlatform || !serviceInstalledPath) {
              try {
                const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv({
                  processEnv: {
                    ...process.env,
                    HAPPIER_DAEMON_SERVICE_INSTANCE_ID: entry.serverId,
                    HAPPIER_DAEMON_SERVICE_SERVER_URL: entry.serverUrl,
                  },
                });
                if (!servicePlatform) servicePlatform = snapshot.platform;
                if (!serviceInstalledPath) serviceInstalledPath = snapshot.installedPath;
              } catch {
                // ignore
              }
            }

            return {
            serverId: entry.serverId,
            name: entry.name,
            serverUrl: entry.serverUrl,
            daemonStatePath: entry.daemonStatePath,
            comparableKey: entry.comparableKey,
            ...(entry.auth ? { auth: entry.auth } : {}),
            ...(entry.drift ? { drift: { ...entry.drift, activeRelayUrl: activeRelayUrl } } : {}),
            service: {
              installed: entry.service.installed,
              running: typeof entry.service.running === 'boolean'
                ? entry.service.running
                : entry.service.installed && entry.daemon.running,
              platform: servicePlatform,
              installedPath: serviceInstalledPath,
            },
            daemon: {
              installed: entry.service.installed,
              running: entry.daemon.running,
              pid: entry.daemon.pid,
              httpPort: entry.daemon.httpPort ?? null,
              staleStateFile: Boolean(entry.daemon.staleStateFile),
            },
            };
          }),
        })}\n`);
        process.exit(0);
      }
      const snapshot = await readDaemonStatusSnapshot();
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      process.exit(0);
    }

    if (args.includes('--all')) {
      const statuses = await listDaemonStatusesForAllKnownServers();
      for (const entry of statuses) {
        const state = entry.daemon.running ? `running (pid ${entry.daemon.pid ?? '—'})` : 'not running';
        console.log(`${entry.name} (${entry.serverId})`);
        if (entry.serverUrl) console.log(`  Relay URL: ${entry.serverUrl}`);
        console.log(`  Daemon: ${state}`);
        if (entry.daemon.staleStateFile) console.log(`  Note: stale state file: ${entry.daemonStatePath}`);
        console.log('');
      }
      process.exit(0);
    }
    await runDoctorCommand('daemon');
    process.exit(0);
  }

  if (daemonSubcommand === 'logs') {
    const latest = await getLatestDaemonLog();
    if (!latest) {
      console.log('No daemon logs found');
    } else {
      console.log(latest.path);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'install') {
    try {
      await runDaemonServiceCliCommand({ argv: ['install', ...args.slice(2)] });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', ...args.slice(2)] });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  printDaemonHelp();
}
