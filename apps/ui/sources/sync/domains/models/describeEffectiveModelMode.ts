import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { hasDynamicModelListForSession, getSelectableModelIdsForSession, supportsFreeformModelSelectionForSession } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState, readSessionModesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

export type ModelApplyScope = 'live' | 'next_prompt' | 'next_resume' | 'spawn_only';
export type ModelRuntimeState = 'active' | 'inactive' | 'unknown';

export type EffectiveModelModeDescription = Readonly<{
    effectiveModelId: string;
    requestedModelId: string;
    lastConfirmedModelId: string | null;
    runtimeState: ModelRuntimeState;
    applyScope: ModelApplyScope;
    notes: string[];
}>;

export function describeEffectiveModelMode(params: {
    agentType: AgentType;
    selectedModelId: string | null | undefined;
    metadata: Metadata | null;
    runtimeState?: ModelRuntimeState;
    inactiveNextResumeNote?: string;
}): EffectiveModelModeDescription {
    const agentId = resolveAgentIdFromFlavor(params.agentType) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);

    const selectedModelId = typeof params.selectedModelId === 'string' ? params.selectedModelId.trim() : '';
    const hasExplicitSelection = selectedModelId.length > 0;
    const requestedModelId = hasExplicitSelection ? selectedModelId : core.model.defaultMode;
    const runtimeState = params.runtimeState ?? 'unknown';
    const providerModelState = readSessionModelsState(params.metadata);
    const providerCurrentModelId = providerModelState?.provider === agentId
        ? providerModelState.currentModelId.trim()
        : '';
    const lastConfirmedModelId = providerCurrentModelId || null;
    const effectiveModelId = runtimeState === 'inactive'
        ? requestedModelId
        : (providerCurrentModelId || requestedModelId);

    const isAcpSession = Boolean(readSessionModesState(params.metadata) || readSessionModelsState(params.metadata));

    let applyScope: ModelApplyScope = runtimeState === 'inactive'
        ? 'next_resume'
        : (isAcpSession ? 'live' : core.model.nonAcpApplyScope);
    const notes: string[] = [];

    switch (applyScope) {
        case 'spawn_only':
            notes.push('Model changes apply when starting a new session.');
            break;
        case 'live':
            notes.push('Model changes are applied to the running session (takes effect on your next message).');
            if (core.model.acpApplyBehavior === 'restart_session') {
                notes.push('This provider restarts the underlying session when switching models (context is preserved when possible).');
            }
            break;
        case 'next_resume': {
            const note = String(params.inactiveNextResumeNote ?? '').trim();
            if (note) notes.push(note);
            break;
        }
        case 'next_prompt':
        default:
            notes.push('Model changes take effect on your next message (and stay active for future messages).');
            break;
    }

    const hasDynamicList = hasDynamicModelListForSession(agentId, params.metadata);
    if (hasExplicitSelection && !hasDynamicList && supportsFreeformModelSelectionForSession(agentId, params.metadata)) {
        const known = getSelectableModelIdsForSession(agentId, params.metadata);
        if (!known.includes(effectiveModelId)) {
            notes.push('This session accepts custom model IDs (not validated).');
        }
    }

    if (core.model.supportsSelection !== true && !hasDynamicList) {
        notes.push('Model selection is not available in the app for this provider.');
    }

    return {
        effectiveModelId,
        requestedModelId,
        lastConfirmedModelId,
        runtimeState,
        applyScope,
        notes,
    };
}
