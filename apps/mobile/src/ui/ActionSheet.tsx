import { Ionicons } from '@expo/vector-icons';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostHogMaskView } from 'posthog-react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

export interface SheetAction {
  key: string;
  label: string;
  /** A short secondary line under the label, for a menu whose options need more
   *  than a name to tell apart (e.g. export formats with different fidelity). */
  description?: string;
  /** Overrides the spoken label when the visible text alone would be ambiguous. */
  accessibilityLabel?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Renders the row in the danger tint (for destructive actions like Delete). */
  destructive?: boolean;
  /** Shows a trailing checkmark (e.g. the bookmark's current collection). */
  selected?: boolean;
  onPress: () => void;
}

/**
 * A bottom action sheet built on the core React Native Modal — no gesture or
 * reanimated dependency. Tapping the dimmed backdrop (or Cancel) dismisses it;
 * taps on the sheet itself are swallowed so it stays open. Used for the Inbox
 * long-press menu so item actions (Open, Share, Move, Archive, Delete) are
 * reachable without opening the detail screen.
 */
export function ActionSheet({
  visible,
  title,
  titleMask,
  actions,
  actionsMask,
  onClose,
}: {
  visible: boolean;
  title?: string;
  /** True when `title` is bookmark-derived content rather than a fixed menu
   *  title (e.g. the Inbox long-press menu's title is the bookmark's own
   *  title). Hides it from PostHog session replay recordings. */
  titleMask?: boolean;
  actions: SheetAction[];
  /** True when every action's `label`/`description` is bookmark-derived
   *  content (e.g. the "move to collection" menu's actions are collection
   *  names) rather than fixed menu labels like "Open"/"Delete". */
  actionsMask?: boolean;
  onClose: () => void;
}) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Cap the scrollable action list so a long list (e.g. many collections in
  // "move" mode) scrolls instead of pushing rows off-screen where they can't
  // be tapped. The title and Cancel stay pinned outside the scroll area.
  const maxListHeight = windowHeight * 0.6;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityRole="button"
        accessibilityLabel={t('actionSheet.dismissA11y')}
        onPress={onClose}
      >
        {/* Swallow presses so tapping the sheet body doesn't dismiss it. */}
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: palette.surfaceElevated, paddingBottom: insets.bottom + 12 },
          ]}
          onPress={() => {}}
        >
          <View style={[styles.grabber, { backgroundColor: palette.border }]} />
          {title ? (
            titleMask ? (
              // `accessible` + `accessibilityLabel` give VoiceOver/TalkBack
              // the real title as one announced unit — standalone (not
              // inside a Pressable), and without it a screen-reader user has
              // no way to tell which bookmark this sheet's generic action
              // labels (Open/Share/Move/Trash) apply to.
              <View accessible accessibilityLabel={title}>
                <PostHogMaskView>
                  <Text style={[styles.title, { color: palette.textSecondary }]} numberOfLines={2}>
                    {title}
                  </Text>
                </PostHogMaskView>
              </View>
            ) : (
              <Text style={[styles.title, { color: palette.textSecondary }]} numberOfLines={2}>
                {title}
              </Text>
            )
          ) : null}
          <ScrollView
            style={{ maxHeight: maxListHeight }}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            {actions.map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={
                  action.accessibilityLabel ??
                  (action.description ? `${action.label}. ${action.description}` : action.label)
                }
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.action,
                  { backgroundColor: pressed ? palette.mutedSurface : 'transparent' },
                ]}
              >
                {action.icon ? (
                  <Ionicons
                    name={action.icon}
                    size={20}
                    color={action.destructive ? palette.danger : palette.text}
                    style={styles.actionIcon}
                  />
                ) : (
                  <View style={styles.actionIcon} />
                )}
                <ActionTextGroup action={action} mask={actionsMask} />
                {action.selected ? <Text style={{ color: palette.accent }}>✓</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
            onPress={onClose}
            style={[styles.cancel, { borderColor: palette.border }]}
          >
            <Text style={[styles.cancelLabel, { color: palette.textSecondary }]}>{t('common.cancel')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionTextGroup({ action, mask }: { action: SheetAction; mask?: boolean }) {
  const palette = usePalette();
  const group = (
    <View style={styles.actionTextGroup}>
      <Text
        style={[styles.actionLabel, { color: action.destructive ? palette.danger : palette.text }]}
        numberOfLines={1}
      >
        {action.label}
      </Text>
      {action.description ? (
        <Text style={[styles.actionDescription, { color: palette.textSecondary }]} numberOfLines={2}>
          {action.description}
        </Text>
      ) : null}
    </View>
  );
  // `styles.actionTextGroup`'s flex: 1 lives on the inner View above; an
  // unstyled PostHogMaskView wrapper wouldn't inherit it, so a long label
  // could take its intrinsic width and push/clip the trailing checkmark —
  // apply the same style to the wrapper too.
  return mask ? <PostHogMaskView style={styles.actionTextGroup}>{group}</PostHogMaskView> : group;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingHorizontal: 12,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    marginBottom: 8,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  actionIcon: {
    width: 28,
  },
  actionTextGroup: {
    flex: 1,
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  actionDescription: {
    fontSize: 12,
    marginTop: 1,
  },
  cancel: {
    marginTop: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  cancelLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
});
