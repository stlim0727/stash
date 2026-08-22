import { useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { PostHogMaskView } from 'posthog-react-native';

import { isSafeMarkdownLink, markdownForDisplay, markdownToPlainText } from '@/domain/markdown';
import { usePalette } from '@/theme';

export function MarkdownBody({ markdown }: { markdown: string }) {
  const palette = usePalette();
  const markdownStyle = useMemo<MarkdownStyle>(
    () => ({
      paragraph: { color: palette.text, fontSize: 16, lineHeight: 24, marginBottom: 10 },
      h1: { color: palette.text, fontSize: 26, lineHeight: 32, marginTop: 8, marginBottom: 12 },
      h2: { color: palette.text, fontSize: 22, lineHeight: 28, marginTop: 8, marginBottom: 10 },
      h3: { color: palette.text, fontSize: 19, lineHeight: 25, marginTop: 6, marginBottom: 8 },
      h4: { color: palette.text, fontSize: 17, lineHeight: 23, marginTop: 6, marginBottom: 8 },
      h5: { color: palette.text, fontSize: 16, lineHeight: 22, marginTop: 4, marginBottom: 6 },
      h6: { color: palette.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 4, marginBottom: 6 },
      blockquote: {
        color: palette.textSecondary,
        borderColor: palette.accent,
        backgroundColor: palette.mutedSurface,
        borderRadius: 8,
        padding: 12,
        marginTop: 6,
        marginBottom: 10,
      },
      list: {
        color: palette.text,
        bulletColor: palette.accent,
        markerColor: palette.accent,
        fontSize: 16,
        lineHeight: 24,
        itemSpacing: 4,
        marginBottom: 10,
      },
      link: { color: palette.accent, underline: true },
      code: {
        color: palette.text,
        backgroundColor: palette.mutedSurface,
        borderColor: palette.border,
      },
      codeBlock: {
        color: palette.text,
        backgroundColor: palette.mutedSurface,
        borderColor: palette.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        padding: 12,
        marginTop: 6,
        marginBottom: 10,
      },
      thematicBreak: { color: palette.border, marginTop: 12, marginBottom: 12 },
      taskList: {
        checkedColor: palette.accent,
        borderColor: palette.border,
        checkmarkColor: palette.background,
        checkedTextColor: palette.textSecondary,
      },
    }),
    [palette],
  );

  const plainTextLabel = markdownToPlainText(markdown);

  return (
    <View style={styles.container}>
      {/* PostHogMaskView below forces its own wrapper's accessibilityLabel to
          the "ph-no-capture" sentinel. A visually-hidden accessible *sibling*
          (not an ancestor wrapping the renderer) restores a real label for
          VoiceOver/TalkBack without collapsing the renderer's own tappable
          links into one opaque, non-interactive node — an ancestor-level
          `accessible` would make those links individually unreachable. */}
      {plainTextLabel ? (
        <Text accessible accessibilityLabel={plainTextLabel} style={styles.srOnly}>
          {plainTextLabel}
        </Text>
      ) : null}
      <PostHogMaskView>
        <EnrichedMarkdownText
          markdown={markdownForDisplay(markdown)}
          flavor="github"
          markdownStyle={markdownStyle}
          md4cFlags={{ latexMath: false }}
          enableTaskListItemToggle={false}
          selectable
          onLinkPress={({ url }) => {
            if (isSafeMarkdownLink(url)) {
              void Linking.openURL(url).catch(() => {});
            }
          }}
        />
      </PostHogMaskView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0,
  },
});
