import { describe, expect, it } from 'vitest';

import {
    isCodexAppServerFastModelEligible,
    isCodexAppServerSpeedEligible,
} from './speedEligibility';

describe('Codex app-server Speed eligibility', () => {
    it.each([
        'gpt-5.4',
        'gpt-5.5',
        'gpt-5.6',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
    ])('keeps legacy fallback support for official Fast model %s', (modelId) => {
        expect(isCodexAppServerFastModelEligible(modelId)).toBe(true);
    });

    it.each([
        'gpt-5.4-mini',
        'gpt-5.5-cyber',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-6',
        '',
    ])('does not infer Fast support for model %s', (modelId) => {
        expect(isCodexAppServerFastModelEligible(modelId)).toBe(false);
    });

    it('prefers model/list service tier capabilities over model-name inference', () => {
        expect(isCodexAppServerSpeedEligible({
            authMethod: 'oauth_cli',
            currentModelId: 'future-model',
            serviceTiers: [
                { id: 'standard', name: 'Standard', description: 'Standard speed' },
                { id: 'fast', name: 'Fast', description: 'Higher speed' },
            ],
        })).toBe(true);

        expect(isCodexAppServerSpeedEligible({
            authMethod: 'oauth_cli',
            currentModelId: 'gpt-5.4',
            serviceTiers: [],
        })).toBe(false);
    });

    it('recognizes the current app-server priority tier labeled Fast', () => {
        expect(isCodexAppServerSpeedEligible({
            authMethod: 'credentials_file',
            currentModelId: 'gpt-5.6-sol',
            serviceTiers: [
                { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
            ],
            additionalSpeedTiers: ['fast'],
        })).toBe(true);
    });

    it('accepts the deprecated additionalSpeedTiers capability from older app-server builds', () => {
        expect(isCodexAppServerSpeedEligible({
            authMethod: 'credentials_file',
            currentModelId: 'future-model',
            additionalSpeedTiers: ['fast'],
        })).toBe(true);
    });

    it.each(['api_key', null, undefined])('still requires ChatGPT-backed authentication (%s)', (authMethod) => {
        expect(isCodexAppServerSpeedEligible({
            authMethod,
            currentModelId: 'gpt-5.6-sol',
            serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Higher speed' }],
        })).toBe(false);
    });
});
