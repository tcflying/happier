import * as React from 'react';
import {
    Platform,
    Text as RNText,
    TextInput as RNTextInput,
    type TextInputProps as RNTextInputProps,
    type TextProps as RNTextProps,
    type TextStyle,
} from 'react-native';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';

import { scaleTextStyle } from './uiFontScale';

const TextSelectabilityContext = React.createContext<boolean>(false);
const TextNestingContext = React.createContext<boolean>(false);
const UNISTYLES_SECRET_KEY_PREFIX = 'unistyles_';
const WEB_DEFAULT_FONT_SIZE = 14;
const NUMERIC_TEXT_METRIC_KEYS = ['fontSize', 'lineHeight', 'letterSpacing'] as const;
const WEB_INPUT_NO_OUTLINE_STYLE = {
    outline: 'none',
    outlineStyle: 'none',
    outlineWidth: 0,
    outlineColor: 'transparent',
    boxShadow: 'none',
} as unknown as TextStyle;

function containsUnistylesSecret(style: unknown): boolean {
    if (!style) return false;
    if (Array.isArray(style)) return style.some(containsUnistylesSecret);
    if (typeof style !== 'object') return false;
    try {
        return Object.getOwnPropertyNames(style).some((key) => key.startsWith(UNISTYLES_SECRET_KEY_PREFIX));
    } catch {
        return false;
    }
}

function containsExplicitFontSize(style: unknown): boolean {
    if (!style) return false;
    if (Array.isArray(style)) return style.some(containsExplicitFontSize);
    if (typeof style !== 'object') return false;
    try {
        return Object.prototype.hasOwnProperty.call(style, 'fontSize')
            && (style as { fontSize?: unknown }).fontSize != null;
    } catch {
        return false;
    }
}

function getUnistylesSecretKeys(style: object): string[] {
    try {
        return Object.getOwnPropertyNames(style).filter((key) => key.startsWith(UNISTYLES_SECRET_KEY_PREFIX));
    } catch {
        return [];
    }
}

function containsPlainNumericTextMetric(style: unknown): boolean {
    if (!style) return false;
    if (Array.isArray(style)) return style.some(containsPlainNumericTextMetric);
    if (typeof style !== 'object') return false;
    if (getUnistylesSecretKeys(style).length > 0) return false;
    return NUMERIC_TEXT_METRIC_KEYS.some((key) => typeof (style as Record<string, unknown>)[key] === 'number');
}

function resolveNumericTextMetrics(style: unknown): TextStyle | null {
    const metrics: TextStyle = {};

    const visit = (entry: unknown) => {
        if (!entry) return;
        if (Array.isArray(entry)) {
            for (const nested of entry) visit(nested);
            return;
        }
        if (typeof entry !== 'object') return;

        const secretKeys = getUnistylesSecretKeys(entry);
        if (secretKeys.length > 0) {
            let resolvedSecret = false;
            for (const key of secretKeys) {
                const secret = (entry as Record<string, any>)[key];
                if (typeof secret?.uni__getStyles !== 'function') continue;
                try {
                    visit(secret.uni__getStyles());
                    resolvedSecret = true;
                } catch {
                    // Fall back to any directly readable numeric metrics below.
                }
            }
            if (resolvedSecret) return;
        }

        for (const key of NUMERIC_TEXT_METRIC_KEYS) {
            const value = (entry as Record<string, unknown>)[key];
            if (typeof value === 'number' && Number.isFinite(value)) {
                (metrics as Record<string, number>)[key] = value;
            }
        }
    };

    visit(style);
    return NUMERIC_TEXT_METRIC_KEYS.some((key) => typeof metrics[key] === 'number') ? metrics : null;
}

function resolveMixedWebTextMetricOverride(params: Readonly<{
    style: unknown;
    uiFontScale: unknown;
    enabled: boolean;
}>): TextStyle | null {
    if (!params.enabled) return null;
    const metrics = resolveNumericTextMetrics(params.style);
    if (!metrics) return null;
    const scale = typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale) && params.uiFontScale > 0
        ? params.uiFontScale
        : 1;
    return scaleTextStyle(metrics, scale) as TextStyle;
}

function resolveWebDefaultFontScaleStyle(params: Readonly<{
    style: unknown;
    uiFontScale: unknown;
    webUnistylesHasFontSize: boolean;
    disableUiFontScaling: boolean;
    isNestedText: boolean;
}>): TextStyle | null {
    if (Platform.OS !== 'web') return null;
    if (params.disableUiFontScaling || params.webUnistylesHasFontSize) return null;
    if (params.isNestedText) return null;
    if (containsExplicitFontSize(params.style)) return null;
    const scale = typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale) && params.uiFontScale > 0
        ? params.uiFontScale
        : 1;
    if (scale === 1) return null;
    return { fontSize: Math.round(WEB_DEFAULT_FONT_SIZE * scale * 100) / 100 };
}

export function TextSelectabilityScope(props: Readonly<{ selectable: boolean; children: React.ReactNode }>) {
    return (
        <TextSelectabilityContext.Provider value={props.selectable}>
            {props.children}
        </TextSelectabilityContext.Provider>
    );
}

export type AppTextProps = RNTextProps & Readonly<{
    /**
     * Whether to use the default typography. Set to false to skip the default font.
     * Useful when you want to control typography via `style` (e.g. `Typography.mono()`).
     */
    useDefaultTypography?: boolean;
    /** Whether the text should be selectable. Defaults to false. */
    selectable?: boolean;
    /** Escape hatch for special surfaces (defaults to false). */
    disableUiFontScaling?: boolean;
    /** Web-only data attributes preserved when the font-scale marker is added. */
    dataSet?: Readonly<Record<string, string>>;
}>;

export const Text = React.memo(
    React.forwardRef<any, AppTextProps>(function AppText(
        {
            style,
            useDefaultTypography = true,
            selectable,
            disableUiFontScaling = false,
            ...props
        },
        ref
    ) {
        const uiFontScaleSetting = useLocalSetting('uiFontScale');
        const isNestedText = React.useContext(TextNestingContext);
        const webHasUnistylesSecret = Platform.OS === 'web' && containsUnistylesSecret(style);
        const webUsesMixedJsFontScale = webHasUnistylesSecret
            && !disableUiFontScaling
            && containsPlainNumericTextMetric(style);
        const resolvedWebNumericTextMetrics = webHasUnistylesSecret
            ? resolveNumericTextMetrics(style)
            : null;
        const webUnistylesHasNumericTextMetric = resolvedWebNumericTextMetrics !== null;
        const webUnistylesHasFontSize = typeof resolvedWebNumericTextMetrics?.fontSize === 'number';
        const webUsesGlobalCssFontScale = Platform.OS === 'web'
            && !disableUiFontScaling
            && webHasUnistylesSecret
            && webUnistylesHasNumericTextMetric
            && !webUsesMixedJsFontScale;
        // Plain inline Web metrics need the JS owner because the global scanner only
        // sees Unistyles classes. Secret-backed Web styles stay at their base values
        // for the CSS owner, avoiding 2x -> 4x and 3x -> 9x multiplication.
        const uiFontScale = disableUiFontScaling || webUsesGlobalCssFontScale ? 1 : uiFontScaleSetting;
        const selectableFromScope = React.useContext(TextSelectabilityContext);
        const effectiveSelectable = selectable ?? selectableFromScope;
        const { accessibilityLabel, testID, dataSet, ...restProps } = props;
        const resolvedDataSet = Platform.OS === 'web' && !webUsesGlobalCssFontScale
            ? { ...dataSet, happierUiFontScale: 'disabled' }
            : dataSet;
        const resolvedDataSetProps = resolvedDataSet ? { dataSet: resolvedDataSet } : undefined;

        const scaledStyle = React.useMemo(() => scaleTextStyle(style as any, uiFontScale), [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mixedWebTextMetricOverride = resolveMixedWebTextMetricOverride({
            style,
            uiFontScale: uiFontScaleSetting,
            enabled: webUsesMixedJsFontScale,
        });
        const webDefaultFontScaleStyle = resolveWebDefaultFontScaleStyle({
            style,
            uiFontScale: uiFontScaleSetting,
            webUnistylesHasFontSize,
            disableUiFontScaling,
            isNestedText,
        });
        const mergedStyle = React.useMemo(() => {
            const out: any[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (webDefaultFontScaleStyle) out.push(webDefaultFontScaleStyle);
            if (Array.isArray(scaledStyle)) out.push(...scaledStyle);
            else if (scaledStyle) out.push(scaledStyle);
            if (mixedWebTextMetricOverride) out.push(mixedWebTextMetricOverride);
            return out;
        }, [defaultStyle, mixedWebTextMetricOverride, scaledStyle, webDefaultFontScaleStyle]);

        return (
            <TextNestingContext.Provider value={true}>
                <RNText
                    ref={ref}
                    style={mergedStyle}
                    selectable={effectiveSelectable}
                    accessibilityLabel={accessibilityLabel}
                    testID={testID}
                    {...restProps}
                    {...resolvedDataSetProps}
                />
            </TextNestingContext.Provider>
        );
    })
);

export type AppTextInputProps = RNTextInputProps & Readonly<{
    useDefaultTypography?: boolean;
    disableUiFontScaling?: boolean;
    /** Web-only data attributes preserved when the font-scale marker is added. */
    dataSet?: Readonly<Record<string, string>>;
}>;

export const TextInput = React.memo(
    React.forwardRef<any, AppTextInputProps>(function AppTextInput(
        { style, useDefaultTypography = true, disableUiFontScaling = false, ...props },
        ref
    ) {
        const uiFontScaleSetting = useLocalSetting('uiFontScale');
        const webHasUnistylesSecret = Platform.OS === 'web' && containsUnistylesSecret(style);
        const webUsesMixedJsFontScale = webHasUnistylesSecret
            && !disableUiFontScaling
            && containsPlainNumericTextMetric(style);
        const resolvedWebNumericTextMetrics = webHasUnistylesSecret
            ? resolveNumericTextMetrics(style)
            : null;
        const webUnistylesHasNumericTextMetric = resolvedWebNumericTextMetrics !== null;
        const webUnistylesHasFontSize = typeof resolvedWebNumericTextMetrics?.fontSize === 'number';
        const webUsesGlobalCssFontScale = Platform.OS === 'web'
            && !disableUiFontScaling
            && webHasUnistylesSecret
            && webUnistylesHasNumericTextMetric
            && !webUsesMixedJsFontScale;
        const uiFontScale = disableUiFontScaling || webUsesGlobalCssFontScale ? 1 : uiFontScaleSetting;
        const { accessibilityLabel, testID, dataSet, ...restProps } = props;
        const resolvedDataSet = Platform.OS === 'web' && !webUsesGlobalCssFontScale
            ? { ...dataSet, happierUiFontScale: 'disabled' }
            : dataSet;
        const resolvedDataSetProps = resolvedDataSet ? { dataSet: resolvedDataSet } : undefined;

        const scaledStyle = React.useMemo(() => scaleTextStyle(style as any, uiFontScale) as TextStyle, [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mixedWebTextMetricOverride = resolveMixedWebTextMetricOverride({
            style,
            uiFontScale: uiFontScaleSetting,
            enabled: webUsesMixedJsFontScale,
        });
        const webDefaultFontScaleStyle = resolveWebDefaultFontScaleStyle({
            style,
            uiFontScale: uiFontScaleSetting,
            webUnistylesHasFontSize,
            disableUiFontScaling,
            isNestedText: false,
        });
        const mergedStyle = React.useMemo(() => {
            const out: any[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (webDefaultFontScaleStyle) out.push(webDefaultFontScaleStyle);
            if (Array.isArray(scaledStyle)) out.push(...scaledStyle);
            else if (scaledStyle) out.push(scaledStyle);
            if (mixedWebTextMetricOverride) out.push(mixedWebTextMetricOverride);
            if (Platform.OS === 'web') out.push(WEB_INPUT_NO_OUTLINE_STYLE);
            return out;
        }, [defaultStyle, mixedWebTextMetricOverride, scaledStyle, webDefaultFontScaleStyle]);

        return (
            <RNTextInput
                ref={ref}
                style={mergedStyle}
                accessibilityLabel={accessibilityLabel}
                testID={testID}
                {...restProps}
                {...resolvedDataSetProps}
            />
        );
    })
);
