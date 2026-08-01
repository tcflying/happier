import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import {
    formatUiFontScaleMultiplier,
    HEADER_UI_FONT_SCALE_PRESET_IDS,
    resolveHeaderUiFontScalePresetId,
    UI_FONT_SCALE_PRESETS,
} from '@/components/ui/text/uiFontScalePresets';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

const MENU_WIDTH = 208;

export const HeaderUiFontScaleMenu = React.memo(function HeaderUiFontScaleMenu() {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const selectedId = resolveHeaderUiFontScalePresetId(uiFontScale);
    const currentMultiplier = formatUiFontScaleMultiplier(uiFontScale);

    const items = React.useMemo<readonly DropdownMenuItem[]>(() => [
        {
            id: 'default',
            testID: 'header-ui-font-scale-option-default',
            title: t('settingsAppearance.textSizeOptions.default'),
            subtitle: '1×',
        },
        {
            id: 'large',
            testID: 'header-ui-font-scale-option-large',
            title: formatUiFontScaleMultiplier(UI_FONT_SCALE_PRESETS.large),
        },
        {
            id: 'xlarge',
            testID: 'header-ui-font-scale-option-xlarge',
            title: formatUiFontScaleMultiplier(UI_FONT_SCALE_PRESETS.xlarge),
        },
        {
            id: 'xxlarge',
            testID: 'header-ui-font-scale-option-xxlarge',
            title: formatUiFontScaleMultiplier(UI_FONT_SCALE_PRESETS.xxlarge),
        },
        {
            id: 'oneAndHalf',
            testID: 'header-ui-font-scale-option-one-and-half',
            title: formatUiFontScaleMultiplier(UI_FONT_SCALE_PRESETS.oneAndHalf),
        },
        {
            id: 'double',
            testID: 'header-ui-font-scale-option-double',
            title: t('settingsAppearance.textSizeOptions.double'),
        },
        {
            id: 'triple',
            testID: 'header-ui-font-scale-option-triple',
            title: t('settingsAppearance.textSizeOptions.triple'),
        },
    ], []);

    const selectScale = React.useCallback((itemId: string) => {
        const presetId = HEADER_UI_FONT_SCALE_PRESET_IDS.find((id) => id === itemId);
        if (!presetId) return;
        setUiFontScale(UI_FONT_SCALE_PRESETS[presetId]);
    }, [setUiFontScale]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={selectedId}
            onSelect={selectScale}
            search={false}
            variant="selectable"
            rowKind="item"
            matchTriggerWidth={false}
            maxWidthCap={MENU_WIDTH}
            placement="bottom"
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
                <Pressable
                    testID="header-ui-font-scale-menu"
                    onPress={toggle}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('settingsAppearance.textSize')}: ${currentMultiplier}`}
                    accessibilityState={{ expanded: open }}
                    style={({ pressed }) => ({
                        height: 32,
                        minWidth: 52,
                        paddingHorizontal: 8,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: pressed ? 0.72 : 1,
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="text-outline" size={14} color={theme.colors.text.secondary} />
                        <Text
                            disableUiFontScaling
                            style={{
                                color: theme.colors.text.primary,
                                fontSize: 12,
                                fontWeight: '600',
                            }}
                        >
                            {currentMultiplier}
                        </Text>
                    </View>
                </Pressable>
            )}
        />
    );
});
