import { useState, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Collection } from '@/domain/types';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';

export interface MergeCollectionsDialogProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  sourceCollections: Collection[];
  availableTargets: Collection[];
  onMerge: (targetCollectionId: string) => void;
  onClose: () => void;
}

export function MergeCollectionsDialog({
  visible,
  busy,
  error,
  sourceCollections,
  availableTargets,
  onMerge,
  onClose,
}: MergeCollectionsDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

  const isMultiSource = sourceCollections.length > 1;

  useEffect(() => {
    if (visible && availableTargets.length > 0) {
      if (!selectedTargetId || !availableTargets.some((c) => c.id === selectedTargetId)) {
        setSelectedTargetId(availableTargets[0]?.id ?? null);
      }
    }
  }, [visible, availableTargets, selectedTargetId]);

  const selectedTarget = availableTargets.find((col) => col.id === selectedTargetId);

  const submit = () => {
    if (!selectedTargetId || busy) return;
    onMerge(selectedTargetId);
  };

  const confirmLabel =
    isMultiSource && selectedTarget
      ? t('folder.mergeIntoConfirm', { target: selectedTarget.name })
      : t('folder.mergeConfirm');

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
            <Ionicons name="git-merge-outline" size={24} color={palette.accent} />
            <Text style={[styles.title, { color: palette.text }]}>{t('folder.mergeTitle')}</Text>
          </View>

          <Text style={[styles.body, { color: palette.textSecondary }]}>
            {isMultiSource ? t('folder.mergeMultiPrompt') : t('folder.mergePrompt')}
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {availableTargets.map((col) => {
              const isSelected = col.id === selectedTargetId;
              return (
                <Pressable
                  key={col.id}
                  testID={`merge-target-${col.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={col.name}
                  disabled={busy}
                  onPress={() => setSelectedTargetId(col.id)}
                  style={({ pressed }) => [
                    styles.targetItem,
                    {
                      backgroundColor: isSelected ? palette.accentSoft : palette.surface,
                      borderColor: isSelected ? palette.accent : palette.border,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Ionicons
                    name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={isSelected ? palette.accent : palette.textSecondary}
                  />
                  <Text
                    style={[
                      styles.targetName,
                      { color: isSelected ? palette.accentText : palette.text },
                    ]}
                    numberOfLines={1}
                  >
                    {col.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {isMultiSource && selectedTarget ? (
            <Text
              testID="merge-collections-notice"
              style={[styles.notice, { color: palette.textSecondary }]}
            >
              {t('folder.mergeMultiNotice', { target: selectedTarget.name })}
            </Text>
          ) : null}

          {error ? (
            <Text style={[styles.error, { color: palette.danger }]}>{error}</Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              testID="merge-collections-cancel"
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={[styles.button, { borderColor: palette.border }]}
            >
              <Text style={[styles.buttonLabel, { color: palette.text }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              testID="merge-collections-submit"
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              disabled={busy || !selectedTargetId}
              onPress={submit}
              style={[
                styles.button,
                styles.buttonPrimary,
                {
                  backgroundColor: palette.accent,
                  opacity: busy || !selectedTargetId ? 0.5 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={palette.accentForeground} size="small" />
              ) : (
                <Text style={[styles.buttonLabel, { color: palette.accentForeground }]}>
                  {confirmLabel}
                </Text>
              )}
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
    maxHeight: '80%',
    borderRadius: 20,
    padding: 20,
    gap: 12,
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
  },
  list: {
    maxHeight: 240,
  },
  listContent: {
    gap: 8,
    paddingVertical: 4,
  },
  targetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  targetName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  error: {
    fontSize: 13,
    fontWeight: '500',
  },
  notice: {
    fontSize: 12,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 6,
  },
  button: {
    minWidth: 84,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    borderWidth: 0,
  },
  buttonLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
});
