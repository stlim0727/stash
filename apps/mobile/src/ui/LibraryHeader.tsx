import type { ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { YellowDuck } from '@/ui/assets/YellowDuck';

export function LibraryHeader({ count, status, unread, menuOpen, disabled, onTop, onMenu }: {
  count: number; status: ReactNode; unread: number; menuOpen: boolean; disabled: boolean;
  onTop: () => void; onMenu: () => void;
}) {
  const t = useT();
  const palette = usePalette();
  return <View style={styles.header}>
    <View style={styles.row}>
      <Pressable testID="inbox-hero-wordmark" accessibilityRole="button"
        accessibilityLabel={t('app.name')} accessibilityHint={t('inbox.scrollToTopA11y')}
        onPress={onTop} style={styles.brand}>
        <YellowDuck />
        <Text accessible={false} style={[styles.wordmark, { color: palette.text }]}>{t('app.name')}</Text>
      </Pressable>
      <Pressable testID="inbox-menu-open" accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `${t('inbox.menuA11y')}, ${t('inbox.newSuggestionsA11y', { count: unread })}` : t('inbox.menuA11y')}
        accessibilityState={{ expanded: menuOpen, disabled }} disabled={disabled}
        onPress={onMenu} style={styles.menu}>
        <Ionicons name="ellipsis-horizontal" size={24} color={palette.text} />
        {unread > 0 ? <View testID="inbox-menu-notification" accessible={false}
          style={[styles.dot, { backgroundColor: palette.accent }]} /> : null}
      </Pressable>
    </View>
    <View style={styles.status}>
      <Text style={{ fontSize: 13, color: palette.textSecondary }}>{t('inbox.savedCount', { count })}</Text>
      {status}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  header: { flex: 1, minWidth: 0, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, flexShrink: 1 },
  wordmark: { fontSize: 28, fontWeight: '800', flexShrink: 1 },
  menu: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dot: { position: 'absolute', width: 7, height: 7, borderRadius: 4, right: 9, top: 10 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
});
