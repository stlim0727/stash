import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

export interface DeleteCollectionDialogProps {
  visible: boolean;
  busy: boolean;
  collectionCount: number;
  collectionName?: string;
  bookmarkCount: number;
  onDeleteKeep: () => void;
  onDeleteTrash: () => void;
  onClose: () => void;
}

export function DeleteCollectionDialog({
  visible,
  busy,
  collectionCount,
  collectionName,
  bookmarkCount,
  onDeleteKeep,
  onDeleteTrash,
  onClose,
}: DeleteCollectionDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();

  const title =
    collectionCount > 1
      ? t('folder.deleteConfirmMultiTitle', { count: collectionCount })
      : collectionName
        ? `“${collectionName}” ${t('folder.deleteConfirmTitle')}`
        : t('folder.deleteConfirmTitle');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
        onPress={busy ? undefined : onClose}
      >
        <Pressable
          style={[
            styles.card,
            { backgroundColor: palette.surfaceElevated, marginBottom: insets.bottom + 24 },
          ]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Ionicons name="trash-outline" size={24} color={palette.danger} />
            <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
          </View>

          <Text style={[styles.body, { color: palette.textSecondary }]}>
            {t('folder.deleteBody', { count: bookmarkCount })}
          </Text>

          {busy ? (
            <View style={styles.busyContainer}>
              <ActivityIndicator color={palette.accent} size="small" />
            </View>
          ) : (
            <View style={styles.options}>
              {/* Option 1: Keep bookmarks (Uncategorize) */}
              <Pressable
                testID="delete-collection-keep-button"
                accessibilityRole="button"
                accessibilityLabel={t('folder.deleteKeepBookmarks')}
                onPress={onDeleteKeep}
                style={({ pressed }) => [
                  styles.optionButton,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <View style={[styles.optionIconContainer, { backgroundColor: palette.accentSoft }]}>
                  <Ionicons name="file-tray-outline" size={20} color={palette.accent} />
                </View>
                <View style={styles.optionContent}>
                  <Text style={[styles.optionTitle, { color: palette.text }]}>
                    {t('folder.deleteKeepBookmarks')}
                  </Text>
                  <Text style={[styles.optionDesc, { color: palette.textSecondary }]}>
                    {t('folder.deleteKeepBookmarksDesc')}
                  </Text>
                </View>
              </Pressable>

              {/* Option 2: Move bookmarks to Trash */}
              <Pressable
                testID="delete-collection-trash-button"
                accessibilityRole="button"
                accessibilityLabel={t('folder.deleteTrashBookmarks')}
                onPress={onDeleteTrash}
                style={({ pressed }) => [
                  styles.optionButton,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <View style={[styles.optionIconContainer, { backgroundColor: palette.dangerSoft ?? 'rgba(239, 68, 68, 0.1)' }]}>
                  <Ionicons name="trash-outline" size={20} color={palette.danger} />
                </View>
                <View style={styles.optionContent}>
                  <Text style={[styles.optionTitle, { color: palette.danger }]}>
                    {t('folder.deleteTrashBookmarks')}
                  </Text>
                  <Text style={[styles.optionDesc, { color: palette.textSecondary }]}>
                    {t('folder.deleteTrashBookmarksDesc')}
                  </Text>
                </View>
              </Pressable>
            </View>
          )}

          <View style={styles.actions}>
            <Pressable
              testID="delete-collection-cancel"
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={[styles.cancelButton, { borderColor: palette.border }]}
            >
              <Text style={[styles.cancelLabel, { color: palette.text }]}>{t('common.cancel')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 20,
    padding: 20,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  busyContainer: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  options: {
    gap: 10,
    marginTop: 4,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionContent: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  optionDesc: {
    fontSize: 12,
    lineHeight: 16,
  },
  actions: {
    marginTop: 6,
    alignItems: 'flex-end',
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
