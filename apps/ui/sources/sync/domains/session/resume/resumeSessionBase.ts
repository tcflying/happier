import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionOptions } from '@/sync/ops';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { canContinueSessionWithFreshSpawn, canResumeSessionWithOptions, getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { deriveAcpBackendIdFromFlavor } from '@/agents/runtime/acpFlavor';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { SessionAuthoringValueV1Schema } from '@happier-dev/protocol';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import type { ModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';

export type ResumeSessionBaseOptions = ResumeSessionOptions;

type ResumeSessionTargetOverride = Readonly<{
    machineId?: string | null;
    directory?: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parsePersistedConnectedServices(value: unknown): ResumeSessionBaseOptions['connectedServices'] | undefined {
    const parsed = SessionAuthoringValueV1Schema.shape.connectedServices.safeParse(value);
    return parsed.success && parsed.data != null ? parsed.data : undefined;
}

function parsePersistedConnectedServicesUpdatedAt(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requiresStrictNativeThreadResume(agentId: string, session: Session, resumeId: string | null): boolean {
    if (resumeId) return false;
    if (agentId !== 'codex' && agentId !== 'claude' && agentId !== 'opencode') return false;
    return Number.isInteger(session.seq) && session.seq > 0;
}

export function buildResumeSessionBaseOptionsFromSession(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: ResumeSessionTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    modelOverride?: ModelOverrideForSpawn | null;
}): ResumeSessionBaseOptions | null {
    const { sessionId, session, resumeCapabilityOptions, resumeTargetOverride, permissionOverride, modelOverride } = opts;

    const reachableTarget = readMachineControlTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resumeTargetOverride?.machineId)
        ?? normalizeNonEmptyString(reachableTarget?.machineId);
    const directory = normalizeNonEmptyString(resumeTargetOverride?.directory)
        ?? normalizeNonEmptyString(reachableTarget?.basePath);
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory) return null;

    const configuredAcpBackendIdFromMetadata =
        typeof session.metadata?.acpConfiguredBackendV1?.backendId === 'string'
            ? session.metadata.acpConfiguredBackendV1.backendId.trim()
            : '';
    const configuredAcpBackendIdFromFlavor = deriveAcpBackendIdFromFlavor(flavor);
    const configuredAcpBackendId =
        configuredAcpBackendIdFromFlavor !== null
            ? (configuredAcpBackendIdFromMetadata.length > 0 ? configuredAcpBackendIdFromMetadata : configuredAcpBackendIdFromFlavor)
            : null;

    // Note: vendor resume IDs can be missing even for otherwise-resumable sessions.
    // Wake/resume still needs to work (e.g. pending-queue wake) and should attach the vendor id only when present.
    // A provider session that never started (no vendor resume id persisted) is still
    // continuable by a fresh spawn against the same Happier session (QA A-F5).
    if (
        !canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)
        && !canContinueSessionWithFreshSpawn(session.metadata, resumeCapabilityOptions)
    ) return null;

    if (configuredAcpBackendId !== null) {
        return {
            sessionId,
            machineId,
            directory,
            backendTarget: { kind: 'configuredAcpBackend', backendId: configuredAcpBackendId },
            ...(permissionOverride ? permissionOverride : {}),
            ...(modelOverride ? modelOverride : {}),
        };
    }

    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    const resume = getAgentVendorResumeId(session.metadata, agentId, resumeCapabilityOptions);
    if (requiresStrictNativeThreadResume(agentId, session, resume)) return null;
    const connectedServices = parsePersistedConnectedServices(session.metadata?.connectedServices);
    const connectedServicesUpdatedAt = parsePersistedConnectedServicesUpdatedAt(session.metadata?.connectedServicesUpdatedAt);

    return {
        sessionId,
        machineId,
        directory,
        backendTarget: { kind: 'builtInAgent', agentId: getAgentCore(agentId).cli.spawnAgent },
        ...(resume ? { resume } : {}),
        ...(connectedServices !== undefined ? { connectedServices } : {}),
        ...(connectedServices !== undefined && connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt } : {}),
        ...(session.metadata?.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: session.metadata.agentRuntimeDescriptorV1 } : {}),
        ...(permissionOverride ? permissionOverride : {}),
        ...(modelOverride ? modelOverride : {}),
    };
}
