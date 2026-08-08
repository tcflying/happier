export type UiFontScalePreset = Readonly<{
    id: string;
    scale: number;
    translationKey?: 'settingsAppearance.textSizeOptions.xxsmall'
        | 'settingsAppearance.textSizeOptions.xsmall'
        | 'settingsAppearance.textSizeOptions.small'
        | 'settingsAppearance.textSizeOptions.default'
        | 'settingsAppearance.textSizeOptions.large'
        | 'settingsAppearance.textSizeOptions.xlarge'
        | 'settingsAppearance.textSizeOptions.xxlarge';
}>;

export const APPEARANCE_UI_FONT_SCALE_PRESETS = [
    { id: 'xxsmall', scale: 0.8, translationKey: 'settingsAppearance.textSizeOptions.xxsmall' },
    { id: 'xsmall', scale: 0.85, translationKey: 'settingsAppearance.textSizeOptions.xsmall' },
    { id: 'small', scale: 0.93, translationKey: 'settingsAppearance.textSizeOptions.small' },
    { id: 'default', scale: 1, translationKey: 'settingsAppearance.textSizeOptions.default' },
    { id: 'large', scale: 1.1, translationKey: 'settingsAppearance.textSizeOptions.large' },
    { id: 'xlarge', scale: 1.2, translationKey: 'settingsAppearance.textSizeOptions.xlarge' },
    { id: 'xxlarge', scale: 1.3, translationKey: 'settingsAppearance.textSizeOptions.xxlarge' },
    { id: 'xhuge', scale: 1.5, translationKey: undefined },
    { id: 'xxhuge', scale: 2, translationKey: undefined },
    { id: 'xxxhuge', scale: 3, translationKey: undefined },
] as const satisfies readonly UiFontScalePreset[];

export const HEADER_UI_FONT_SCALE_PRESETS = APPEARANCE_UI_FONT_SCALE_PRESETS.filter(
    (preset) => preset.scale >= 1,
);

export function getUiFontScalePreset(id: string): UiFontScalePreset | null {
    return APPEARANCE_UI_FONT_SCALE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function findUiFontScalePresetByScale(scale: number | null | undefined): UiFontScalePreset | null {
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return null;
    return APPEARANCE_UI_FONT_SCALE_PRESETS.find((preset) => preset.scale === scale) ?? null;
}

export function findClosestUiFontScalePreset(scale: number | null | undefined): UiFontScalePreset {
    const candidate = typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
    return APPEARANCE_UI_FONT_SCALE_PRESETS.reduce((closest, preset) => (
        Math.abs(preset.scale - candidate) < Math.abs(closest.scale - candidate) ? preset : closest
    ));
}

export function formatUiFontScalePercent(scale: number): string {
    return `${Math.round(scale * 100)}%`;
}
