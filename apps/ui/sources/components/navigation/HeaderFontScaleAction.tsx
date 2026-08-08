import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import {
    findUiFontScalePresetByScale,
    formatUiFontScalePercent,
    getUiFontScalePreset,
    HEADER_UI_FONT_SCALE_PRESETS,
} from '@/components/ui/text/uiFontScalePresets';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export const HeaderFontScaleAction = React.memo(function HeaderFontScaleAction() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [uiFontScale, setUiFontScale] = useLocalSettingMutable('uiFontScale');
    const [open, setOpen] = React.useState(false);
    const currentPreset = findUiFontScalePresetByScale(uiFontScale);
    const headerMenuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        const currentOutsideHeaderMenu = currentPreset && !HEADER_UI_FONT_SCALE_PRESETS.some(
            (preset) => preset.id === currentPreset.id,
        );
        const currentItem = currentOutsideHeaderMenu ? [{
            id: currentPreset.id,
            title: currentPreset.translationKey ? t(currentPreset.translationKey) : formatUiFontScalePercent(currentPreset.scale),
            subtitle: formatUiFontScalePercent(currentPreset.scale),
        }] : [];

        return [
            ...currentItem,
            ...HEADER_UI_FONT_SCALE_PRESETS.map((preset) => ({
                id: preset.id,
                title: formatUiFontScalePercent(preset.scale),
            })),
        ];
    }, [currentPreset]);

    const onSelect = React.useCallback((itemId: string) => {
        const preset = getUiFontScalePreset(itemId);
        if (!preset) return;
        setUiFontScale(preset.scale);
    }, [setUiFontScale]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={headerMenuItems}
            onSelect={onSelect}
            selectedId={currentPreset?.id ?? null}
            variant="selectable"
            rowKind="item"
            placement="bottom"
            matchTriggerWidth={false}
            maxWidthCap={160}
            popoverAnchorAlign="end"
            trigger={({ open: menuOpen, toggle }) => (
                <Pressable
                    testID="header-font-scale-trigger"
                    accessibilityRole="button"
                    accessibilityLabel={t('settingsAppearance.textSize')}
                    accessibilityHint={t('settingsAppearance.textSizeDescription')}
                    accessibilityState={{ expanded: menuOpen }}
                    hitSlop={8}
                    onPress={toggle}
                    style={[styles.trigger, menuOpen ? styles.triggerOpen : null]}
                >
                    <Icon name="text-aa" size={20} color={theme.colors.chrome.header.foreground} />
                </Pressable>
            )}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    trigger: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 22,
    },
    triggerOpen: {
        opacity: 0.72,
    },
}));
