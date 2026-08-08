import type { SessionConfigOptionControl } from '@/sync/domains/sessionControl/configOptionsControl';

const REASONING_CONTROL_IDS = new Set(['reasoning-effort']);
const SPEED_CONTROL_IDS = new Set(['service-tier', 'speed', 'fast']);

function normalizeControlId(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function resolveControlValueLabel(control: SessionConfigOptionControl): string | null {
    const optionLabel = control.option.options
        ?.find((option) => option.value === control.effectiveValue)
        ?.name
        .trim();
    if (optionLabel) return optionLabel;

    const value = String(control.effectiveValue).trim();
    if (!value) return null;
    if (value.toLowerCase() === 'xhigh') return 'XHigh';
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function findControlLabel(
    controls: ReadonlyArray<SessionConfigOptionControl>,
    ids: ReadonlySet<string>,
): string | null {
    const control = controls.find((candidate) => ids.has(normalizeControlId(candidate.option.id)));
    return control ? resolveControlValueLabel(control) : null;
}

/**
 * Returns only the two model controls that are useful at a glance in the
 * composer: reasoning effort first, then speed tier. Other model-specific
 * toggles stay in the model picker so this chip remains compact.
 */
export function resolveAgentChipModelControlSummary(
    controls: ReadonlyArray<SessionConfigOptionControl> | null | undefined,
): readonly string[] {
    if (!controls?.length) return [];

    return [
        findControlLabel(controls, REASONING_CONTROL_IDS),
        findControlLabel(controls, SPEED_CONTROL_IDS),
    ].filter((label): label is string => Boolean(label));
}
