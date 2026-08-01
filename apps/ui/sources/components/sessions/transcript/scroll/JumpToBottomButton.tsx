import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function isTextControlSelectionAtEnd(
    value: string,
    selectionStart: number | null,
    selectionEnd: number | null,
): boolean {
    return typeof selectionStart === 'number'
        && typeof selectionEnd === 'number'
        && selectionStart === value.length
        && selectionEnd === value.length;
}

function isTextControlCaretAtEnd(element: Element): boolean {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    return isTextControlSelectionAtEnd(element.value, element.selectionStart, element.selectionEnd);
}

function isContentEditableCaretAtEnd(element: Element): boolean {
    if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(element);
    range.setStart(selection.focusNode ?? element, selection.focusOffset);
    return range.toString().length === 0;
}

export function shouldHandleJumpToBottomArrowDown(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (event.defaultPrevented) return false;
    const activeElement = document.activeElement;
    if (!activeElement || activeElement === document.body || activeElement === document.documentElement) return true;
    return isTextControlCaretAtEnd(activeElement) || isContentEditableCaretAtEnd(activeElement);
}

export const JumpToBottomButton = React.memo(function JumpToBottomButton(props: {
    count: number;
    onPress: () => void;
    presentation?: 'standard' | 'activity';
    testID?: string;
}) {
    const { theme, rt } = useUnistyles();
    const label = t('settingsSession.transcript.jumpToBottomButtonLabel');
    const accessibilityLabel = props.count > 0
        ? t('settingsSession.transcript.jumpToBottomButtonNewActivityLabel', { count: props.count })
        : label;
    const compact = props.presentation === 'activity' || rt.breakpoint === 'xs' || rt.breakpoint === 'sm' || rt.breakpoint === 'md';
    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!shouldHandleJumpToBottomArrowDown(event)) return;
            event.preventDefault();
            props.onPress();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [props.onPress]);
    return (
        <GlassPanel
            // Match the tab bar's glass look: default solid fill (surface.base), not a
            // grey elevated fill. A small floating control, so a much lighter cast
            // shadow and no inset (the bar's full-strength depth reads too heavy here).
            shadowLevel={2}
            innerShadow={false}
        >
            <Pressable
                testID={props.testID}
                onPress={props.onPress}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityHint="ArrowDown"
                style={({ pressed }) => [styles.row, compact && styles.compactRow, pressed && { opacity: 0.92 }]}
            >
                {props.count > 0 ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{String(props.count)}</Text>
                    </View>
                ) : null}
                {!compact ? (
                    <Text style={styles.label} numberOfLines={1}>
                        {label}
                    </Text>
                ) : null}
                <Ionicons name="chevron-down" size={16} color={theme.colors.text.primary} />
            </Pressable>
        </GlassPanel>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    compactRow: {
        minWidth: 40,
        height: 40,
        paddingHorizontal: 8,
        paddingVertical: 0,
        justifyContent: 'center',
        gap: 6,
    },
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 6,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accent.blue,
    },
    badgeText: {
        fontSize: 11,
        fontWeight: '700',
        color: theme.colors.surface.base,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
}));
