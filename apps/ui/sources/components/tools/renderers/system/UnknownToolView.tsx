import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '../../normalization/parse/parseJson';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    formatUnknownToolInputText,
    formatUnknownToolResultText,
    formatUnknownToolSubtitle,
    shouldShowUnknownToolResult,
} from './unknownToolContent';

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

export const UnknownToolView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;

    const subtitle = formatUnknownToolSubtitle(tool.input);
    const inputText = formatUnknownToolInputText(tool.input);
    const resultText = formatUnknownToolResultText(tool.result);
    const showResult = shouldShowUnknownToolResult(tool);

    if (detailLevel === 'summary') {
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {subtitle ? (
                        <Text style={styles.subtitle} numberOfLines={2}>
                            {subtitle}
                        </Text>
                    ) : null}
                    {showResult && resultText ? <CodeView code={truncate(resultText, 800)} /> : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <Text style={styles.title} numberOfLines={2}>
                    {tool.name}
                </Text>
                {subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={3}>
                        {subtitle}
                    </Text>
                ) : null}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('toolView.input')}</Text>
                    <CodeView code={inputText} />
                </View>
                {showResult ? (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('toolView.output')}</Text>
                        <CodeView code={resultText ?? JSON.stringify(maybeParseJson(tool.result), null, 2)} />
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    title: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    section: {
        gap: 6,
    },
    sectionTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
