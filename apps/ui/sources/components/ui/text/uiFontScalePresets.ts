export const UI_FONT_SCALE_PRESETS = {
    xxsmall: 0.8,
    xsmall: 0.85,
    small: 0.93,
    default: 1,
    large: 1.1,
    xlarge: 1.2,
    xxlarge: 1.3,
    double: 2,
    triple: 3,
} as const;

export type UiFontScalePresetId = keyof typeof UI_FONT_SCALE_PRESETS;

export const HEADER_UI_FONT_SCALE_PRESET_IDS = ['default', 'double', 'triple'] as const satisfies readonly UiFontScalePresetId[];

export type HeaderUiFontScalePresetId = typeof HEADER_UI_FONT_SCALE_PRESET_IDS[number];

export function isUiFontScalePresetId(value: string): value is UiFontScalePresetId {
    return Object.prototype.hasOwnProperty.call(UI_FONT_SCALE_PRESETS, value);
}

export function resolveUiFontScalePresetId(value: number | null | undefined): UiFontScalePresetId {
    const scale = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    const entries = Object.entries(UI_FONT_SCALE_PRESETS) as Array<[UiFontScalePresetId, number]>;
    let best: UiFontScalePresetId = 'default';
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [id, presetScale] of entries) {
        const distance = Math.abs(scale - presetScale);
        if (distance < bestDistance) {
            best = id;
            bestDistance = distance;
        }
    }

    return best;
}

export function resolveHeaderUiFontScalePresetId(value: number | null | undefined): HeaderUiFontScalePresetId | null {
    const scale = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    return HEADER_UI_FONT_SCALE_PRESET_IDS.find(
        (id) => Math.abs(UI_FONT_SCALE_PRESETS[id] - scale) < 0.001,
    ) ?? null;
}

export function formatUiFontScaleMultiplier(value: number | null | undefined): string {
    const scale = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
    return `${Number(scale.toFixed(2))}×`;
}
