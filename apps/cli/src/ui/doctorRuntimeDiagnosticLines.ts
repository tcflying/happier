import type { DoctorRuntimeDiagnostic } from '@happier-dev/protocol';

function valueOrUnknown(value: string | number | null): string {
    return value === null || value === '' ? '(unknown)' : String(value);
}

function formatRunnerContext(
    finding: Exclude<
        DoctorRuntimeDiagnostic,
        { code: 'session_mutation_dead_letter' | 'server_webapp_role_port_drift' }
    >,
): string[] {
    return [
        `    Machine: ${valueOrUnknown(finding.data.machineId)}`,
        `    Session: ${finding.data.sessionId}`,
        `    Runner PID: ${finding.data.pid}`,
        `    Runner generation: ${valueOrUnknown(finding.data.generationId)}`,
        `    Process state: ${finding.data.processState}`,
        `    Last heartbeat: ${valueOrUnknown(finding.data.lastHeartbeatAtMs)}`,
        `    Cleanup phase: ${finding.data.cleanupPhase}`,
        `    Recovery: ${finding.data.recoveryRecommendation}`,
    ];
}

export function formatDoctorRuntimeDiagnosticLines(
    findings: readonly DoctorRuntimeDiagnostic[],
): readonly string[] {
    if (findings.length === 0) return [];

    const lines: string[] = ['Runtime recovery diagnostics'];
    for (const finding of findings) {
        const level = finding.severity === 'error' ? 'BLOCKING' : 'WARNING';
        lines.push(`  - ${level} ${finding.code}`);

        switch (finding.code) {
            case 'session_mutation_dead_letter':
                lines.push(
                    `    Machine: ${valueOrUnknown(finding.data.machineId)}`,
                    `    Sessions: ${finding.data.sessionIds.join(', ') || '(unknown)'}`,
                    `    Dead-letter: ${finding.data.fileName} (${finding.data.entryCount} entries)`,
                    `    Recovery: ${finding.data.recoveryRecommendation}`,
                );
                break;
            case 'server_webapp_role_port_drift':
                lines.push(
                    `    Server profile: ${finding.data.serverId}`,
                    `    Resolved relay URL: ${finding.data.resolvedServerUrl}`,
                    `    Resolved web app URL: ${finding.data.resolvedWebappUrl}`,
                    `    Configured relay URL: ${finding.data.profileServerUrl}`,
                    ...(finding.data.profileLocalServerUrl
                        ? [`    Configured local relay URL: ${finding.data.profileLocalServerUrl}`]
                        : []),
                    `    Configured web app URL: ${finding.data.profileWebappUrl}`,
                    `    Drift: ${finding.data.driftKinds.join(', ')}`,
                    `    Recovery: ${finding.data.recoveryRecommendation}`,
                );
                break;
            default:
                lines.push(...formatRunnerContext(finding));
                break;
        }
    }
    return lines;
}
