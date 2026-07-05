import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

/**
 * The top-right header action cluster shared by all three tabs (Inbox, Library,
 * Tags): a search icon and a settings icon, in consistent order and size. Both
 * are round icon buttons matching the Inbox hero's original settings gear.
 *
 * Kept to just the two actions (not the whole header) so each tab keeps its own
 * bespoke title/hero on the left — the cluster is the only duplicated piece, so
 * it's the only thing lifted here.
 *
 * v1 search: `onSearch` focuses/opens the Inbox's existing inline search. On the
 * Library/Tags tabs it navigates to the Inbox with a `focusSearch` param so the
 * Inbox opens its own search. The full recent-history "search destination" is a
 * later enhancement.
 */
export function TabHeaderActions({
  onSearch,
  onSettings,
}: {
  onSearch: () => void;
  onSettings: () => void;
}) {
  const palette = usePalette();
  const t = useT();
  return (
    <View style={styles.cluster}>
      <Pressable
        testID="tab-header-search"
        accessibilityRole="button"
        accessibilityLabel={t('common.search')}
        hitSlop={8}
        onPress={onSearch}
      >
        <View style={[styles.button, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Ionicons name="search" size={20} color={palette.text} />
        </View>
      </Pressable>
      <Pressable
        testID="tab-header-settings"
        accessibilityRole="button"
        accessibilityLabel={t('common.settings')}
        hitSlop={8}
        onPress={onSettings}
      >
        <View style={[styles.button, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Ionicons name="settings-sharp" size={20} color={palette.text} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
