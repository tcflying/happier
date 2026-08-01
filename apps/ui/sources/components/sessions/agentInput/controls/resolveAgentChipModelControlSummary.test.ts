import { describe, expect, it } from 'vitest';

import type { AcpConfigOptionControl } from '@/sync/acp/configOptionsControl';
import { resolveAgentChipModelControlSummary } from './resolveAgentChipModelControlSummary';

function control(params: Readonly<{
    id: string;
    value: string;
    options?: ReadonlyArray<Readonly<{ value: string; name: string }>>;
}>): AcpConfigOptionControl {
    return {
        option: {
            id: params.id,
            name: params.id,
            type: 'select',
            currentValue: params.value,
            options: params.options,
        },
        effectiveValue: params.value,
        isPending: false,
    };
}

describe('resolveAgentChipModelControlSummary', () => {
    it('shows reasoning before speed using the provider display labels', () => {
        expect(resolveAgentChipModelControlSummary([
            control({
                id: 'service_tier',
                value: 'fast',
                options: [
                    { value: 'standard', name: 'Standard' },
                    { value: 'fast', name: 'Fast' },
                ],
            }),
            control({
                id: 'reasoning_effort',
                value: 'high',
                options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                ],
            }),
        ])).toEqual(['High', 'Fast']);
    });

    it('shows Standard when the model exposes speed but acceleration is off', () => {
        expect(resolveAgentChipModelControlSummary([
            control({
                id: 'service_tier',
                value: 'standard',
                options: [
                    { value: 'standard', name: 'Standard' },
                    { value: 'fast', name: 'Fast' },
                ],
            }),
        ])).toEqual(['Standard']);
    });

    it('does not invent a speed label for models without a speed control', () => {
        expect(resolveAgentChipModelControlSummary([
            control({ id: 'reasoning_effort', value: 'xhigh' }),
            control({ id: 'extended_context_model', value: 'true' }),
        ])).toEqual(['XHigh']);
    });
});
