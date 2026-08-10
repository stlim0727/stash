/**
 * The AI summary rendered as a *proposed note*, sitting directly under the note
 * field on the Bookmark Detail screen. It is deliberately its own dashed,
 * clearly-labeled ghost block — never poured into the note input — so it can't
 * be mistaken for user-authored text. This is the sacred-fields principle made
 * visual: the generated summary stays in this container until the user
 * explicitly chooses it.
 *
 * Accept is conflict-safe: an empty note is *filled* ("Use as note"); a note
 * that already has text is *appended to* ("Add to note"), never overwritten. The
 * caller owns that write (and the durable "reviewed" bookkeeping); this
 * component only decides which label to show and fires the callbacks.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PostHogMaskView } from 'posthog-react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

interface ProposedSummaryProps {
  summary: string;
  /** True when the note is empty, so accept *fills* it ("Use as note"); false
   *  relabels to "Add to note" (append) to signal the non-destructive path. */
  noteEmpty: boolean;
  busy: boolean;
  onUse: () => void;
  onDismiss: () => void;
  /**
   * Override the default accessibility labels below. Detail shows one
   * bookmark per screen, so the default (title-less) labels are unambiguous;
   * Review can show several summary cards at once and passes labels naming
   * the bookmark instead.
   */
  useA11yLabel?: string;
  dismissA11yLabel?: string;
}

export function ProposedSummary({
  summary,
  noteEmpty,
  busy,
  onUse,
  onDismiss,
  useA11yLabel,
  dismissA11yLabel,
}: ProposedSummaryProps) {
  const palette = usePalette();
  const t = useT();
  const useLabel = noteEmpty ? t('detail.summaryUseAsNote') : t('detail.summaryAppendToNote');
  const useA11y =
    useA11yLabel ?? (noteEmpty ? t('detail.summaryUseAsNoteA11y') : t('detail.summaryAppendToNoteA11y'));
  const dismissA11y = dismissA11yLabel ?? t('detail.summaryDismissA11y');

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: palette.surfaceElevated, borderColor: palette.accent },
      ]}
    >
      <Text style={[styles.label, { color: palette.textSecondary }]}>
        {t('detail.summaryLabel')}
      </Text>
      <PostHogMaskView>
        <Text style={[styles.body, { color: palette.text }]}>{summary}</Text>
      </PostHogMaskView>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={useA11y}
          disabled={busy}
          style={[styles.useButton, { borderColor: palette.accent }]}
          onPress={onUse}
        >
          <Text style={[styles.useLabel, { color: palette.accent }]}>{useLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissA11y}
          disabled={busy}
          hitSlop={6}
          style={styles.dismiss}
          onPress={onDismiss}
        >
          <Text style={[styles.dismissLabel, { color: palette.textSecondary }]}>
            {t('detail.summaryDismiss')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderStyle: 'dashed',
    padding: 14,
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 16,
    marginTop: 2,
  },
  useButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  useLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  dismiss: {
    paddingVertical: 7,
  },
  dismissLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
