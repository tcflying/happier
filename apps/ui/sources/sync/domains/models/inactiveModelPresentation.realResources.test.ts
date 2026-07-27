import { afterEach, describe, expect, it } from 'vitest';

import { t, setPreferredLanguageFromSettings } from '@/text';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    findModelOptionForEffectiveModelId,
    getModelOptionsForSession,
} from './modelOptions';
import { describeEffectiveModelMode } from './describeEffectiveModelMode';

const GPT_5_6_TERRA_ID = 'gpt-5.6-terra';
const GPT_5_6_SOL_ID = 'gpt-5.6-sol';

function buildCodexMetadata(): Metadata {
    return {
        path: 'C:\\repo',
        host: 'windows-host',
        sessionModelsV1: {
            v: 1,
            provider: 'codex',
            updatedAt: 1,
            currentModelId: GPT_5_6_SOL_ID,
            availableModels: [
                {
                    id: GPT_5_6_TERRA_ID,
                    name: 'GPT 5.6 Terra',
                    description: 'Balanced agentic coding model for everyday work.',
                },
                {
                    id: GPT_5_6_SOL_ID,
                    name: 'GPT 5.6 Sol',
                    description: 'Frontier agentic coding model.',
                },
            ],
        },
    };
}

afterEach(() => {
    setPreferredLanguageFromSettings(null);
});

describe('inactive Codex model presentation integration', () => {
    it('uses the real session catalog and translation lookup for requested Terra versus confirmed Sol', () => {
        setPreferredLanguageFromSettings('en');
        const metadata = buildCodexMetadata();
        const options = getModelOptionsForSession('codex', metadata);
        const policy = describeEffectiveModelMode({
            agentType: 'codex',
            selectedModelId: GPT_5_6_TERRA_ID,
            metadata,
            runtimeState: 'inactive',
        });

        const requested = findModelOptionForEffectiveModelId(options, policy.effectiveModelId);
        const confirmed = policy.lastConfirmedModelId
            ? findModelOptionForEffectiveModelId(options, policy.lastConfirmedModelId)
            : null;

        expect(requested).toMatchObject({
            value: GPT_5_6_TERRA_ID,
            label: 'GPT 5.6 Terra',
        });
        expect(confirmed).toMatchObject({
            value: GPT_5_6_SOL_ID,
            label: 'GPT 5.6 Sol',
        });
        expect(policy).toMatchObject({
            requestedModelId: GPT_5_6_TERRA_ID,
            lastConfirmedModelId: GPT_5_6_SOL_ID,
            applyScope: 'next_resume',
        });
        expect(t('agentInput.model.requestedNextResume', { model: requested!.label }))
            .toBe('Requested for next resume: GPT 5.6 Terra');
        expect(t('agentInput.model.lastConfirmed', { model: confirmed!.label }))
            .toBe('Last confirmed model: GPT 5.6 Sol');
    });
});
