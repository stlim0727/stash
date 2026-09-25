import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

export interface BulkActionBarProps {
  selectedCount: number;
  isRefreshing?: boolean;
  onRefresh: () => void;
  onMove: () => void;
  onDelete: () => void;
  maxWidth?: number;
  bottomInset?: number;
}

export function BulkActionBar({
  selectedCount,
  isRefreshing = false,
  onRefresh,
  onMove,
  onDelete,
  maxWidth,
  bottomInset = 0,
}: BulkActionBarProps) {
  const palette = usePalette();
  const t = useT();

  const disabled = selectedCount === 0;

  return (
    <View
      testID="inbox-bulk-action-bar"
      accessibilityRole="toolbar"
      accessibilityLabel={t('inbox.bulkToolbarA11y')}
      style={[
        styles.bar,
        {
          backgroundColor: palette.surfaceElevated,
          borderColor: palette.border,
          bottom: bottomInset + 16,
          maxWidth: maxWidth ?? 500,
        },
      ]}
    >
      <Pressable
        testID="inbox-bulk-refresh"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkRefreshA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onRefresh}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        {isRefreshing ? (
          <ActivityIndicator size="small" color={palette.accent} style={styles.iconSlot} />
        ) : (
          <Ionicons
            name="refresh-outline"
            size={20}
            color={disabled ? palette.textSecondary : palette.accent}
            style={styles.iconSlot}
          />
        )}
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.text },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkRefresh')}
        </Text>
      </Pressable>

      <View style={[styles.separator, { backgroundColor: palette.border }]} />

      <Pressable
        testID="inbox-bulk-move"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkMoveA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onMove}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="folder-outline"
          size={20}
          color={disabled ? palette.textSecondary : palette.text}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.text },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkMove')}
        </Text>
      </Pressable>

      <View style={[styles.separator, { backgroundColor: palette.border }]} />

      <Pressable
        testID="inbox-bulk-delete"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkDeleteA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onDelete}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="trash-outline"
          size={20}
          color={disabled ? palette.textSecondary : palette.danger}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.danger },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkDelete')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    ...overlayLayer(10),
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    minHeight: 44,
  },
  iconSlot: {
    marginBottom: 3,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  separator: {
    width: StyleSheet.hairlineWidth,
    height: 28,
  },
});
