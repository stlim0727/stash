import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

export interface FolderBulkActionBarProps {
  selectedCount: number;
  onMerge: () => void;
  onDelete: () => void;
  onRename?: () => void;
  maxWidth?: number;
  bottomInset?: number;
}

export function FolderBulkActionBar({
  selectedCount,
  onMerge,
  onDelete,
  onRename,
  maxWidth,
  bottomInset = 0,
}: FolderBulkActionBarProps) {
  const palette = usePalette();
  const t = useT();

  const disabled = selectedCount === 0;
  const canMerge = selectedCount >= 2;
  const canRename = selectedCount === 1 && Boolean(onRename);

  return (
    <View
      testID="folder-bulk-action-bar"
      accessibilityRole="toolbar"
      accessibilityLabel={t('folder.selectedCount', { count: selectedCount })}
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
      {canRename ? (
        <>
          <Pressable
            testID="folder-bulk-rename"
            accessibilityRole="button"
            accessibilityLabel={t('folder.renameA11y')}
            hitSlop={8}
            onPress={onRename}
            style={({ pressed }) => [
              styles.actionButton,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Ionicons
              name="pencil-outline"
              size={20}
              color={palette.accent}
              style={styles.iconSlot}
            />
            <Text
              style={[styles.actionLabel, { color: palette.text }]}
              numberOfLines={1}
            >
              {t('folder.rename')}
            </Text>
          </Pressable>
          <View style={[styles.separator, { backgroundColor: palette.border }]} />
        </>
      ) : null}

      <Pressable
        testID="folder-bulk-merge"
        accessibilityRole="button"
        accessibilityLabel={t('folder.bulkMergeA11y')}
        accessibilityState={{ disabled: !canMerge }}
        disabled={!canMerge}
        hitSlop={8}
        onPress={onMerge}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: !canMerge ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="git-merge-outline"
          size={20}
          color={!canMerge ? palette.textSecondary : palette.accent}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: !canMerge ? palette.textSecondary : palette.text },
          ]}
          numberOfLines={1}
        >
          {t('folder.bulkMerge')}
        </Text>
      </Pressable>

      <View style={[styles.separator, { backgroundColor: palette.border }]} />

      <Pressable
        testID="folder-bulk-delete"
        accessibilityRole="button"
        accessibilityLabel={t('folder.bulkDeleteA11y')}
        accessibilityState={{ disabled }}
        disabled={disabled}
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
          {t('folder.bulkDelete')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    alignSelf: 'center',
    width: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    ...overlayLayer(12),
  },
  actionButton: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    minHeight: 44,
  },
  iconSlot: {
    marginBottom: 3,
  },
  actionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  separator: {
    width: StyleSheet.hairlineWidth,
    height: 24,
  },
});
