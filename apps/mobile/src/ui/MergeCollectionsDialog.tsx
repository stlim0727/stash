import { useState, useEffect, useRef } from 'react';
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

import { collectionColorKey } from '@/domain/collection-color';
import type { Collection } from '@/domain/types';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';

export interface MergeCollectionsDialogProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  sourceCollections: Collection[];
  availableTargets: Collection[];
  collectionCounts?: Map<string, number>;
  onMerge: (targetCollectionId: string) => void;
  onClose: () => void;
}

export function MergeCollectionsDialog({
  visible,
  busy,
  error,
  sourceCollections,
  availableTargets,
  collectionCounts,
  onMerge,
  onClose,
}: MergeCollectionsDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [targetLost, setTargetLost] = useState(false);
  const prevVisibleRef = useRef(false);

  const isMultiSource = sourceCollections.length > 1;

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      setSelectedTargetId(null);
      setTargetLost(false);
    } else if (!visible && prevVisibleRef.current) {
      setSelectedTargetId(null);
      setTargetLost(false);
    }
    prevVisibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (selectedTargetId !== null) {
      const stillAvailable = availableTargets.some((c) => c.id === selectedTargetId);
      if (!stillAvailable) {
        setSelectedTargetId(null);
        setTargetLost(true);
      }
    }
  }, [visible, availableTargets, selectedTargetId]);

  const handleSelectTarget = (id: string) => {
    if (busy) return;
    setSelectedTargetId(id);
    setTargetLost(false);
  };

  const selectedTarget = availableTargets.find((col) => col.id === selectedTargetId);

  const otherSources = isMultiSource && selectedTarget
    ? sourceCollections.filter((c) => c.id !== selectedTarget.id)
    : selectedTarget
      ? sourceCollections
      : [];
  const otherSourcesNames = otherSources.map((c) => `“${c.name}”`).join(', ');
  const targetCount = selectedTarget ? (collectionCounts?.get(selectedTarget.id) ?? 0) : 0;
  const movingCount = otherSources.reduce(
    (sum, c) => sum + (collectionCounts?.get(c.id) ?? 0),
    0,
  );
  const totalCount = targetCount + movingCount;

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
              const count = collectionCounts?.get(col.id) ?? 0;
              const colorKey = collectionColorKey(col.id);

              if (isMultiSource) {
                const hasSelection = selectedTargetId !== null;
                let badgeIcon: keyof typeof Ionicons.glyphMap = 'radio-button-off';
                let badgeLabel = t('folder.selectTargetBadge');
                let badgeBg: string = palette.surfaceElevated;
                let badgeBorder: string = palette.border;
                let badgeTextColor: string = palette.textSecondary;

                if (isSelected) {
                  badgeIcon = 'checkmark-circle';
                  badgeLabel = t('folder.keepTargetBadge');
                  badgeBg = palette.accent;
                  badgeBorder = palette.accent;
                  badgeTextColor = palette.accentForeground;
                } else if (hasSelection) {
                  badgeIcon = 'arrow-forward';
                  badgeLabel = t('folder.mergeSourceBadge');
                  badgeBg = palette.surfaceElevated;
                  badgeBorder = palette.border;
                  badgeTextColor = palette.textSecondary;
                }

                return (
                  <Pressable
                    key={col.id}
                    testID={`merge-target-${col.id}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${col.name}, ${t('inbox.collectionTileCount', { count })}`}
                    disabled={busy}
                    onPress={() => handleSelectTarget(col.id)}
                    style={({ pressed }) => [
                      styles.vesselCard,
                      {
                        backgroundColor: isSelected ? palette.accentSoft : palette.surface,
                        borderColor: isSelected ? palette.accent : palette.border,
                        borderWidth: isSelected ? 2 : StyleSheet.hairlineWidth,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <View style={styles.vesselCardRow}>
                      <View
                        style={[
                          styles.vesselIconBox,
                          { backgroundColor: palette[colorKey] },
                        ]}
                      >
                        <Ionicons name="folder" size={20} color={palette.text} />
                      </View>
                      <View style={styles.vesselInfo}>
                        <Text
                          style={[
                            styles.vesselName,
                            { color: isSelected ? palette.accentText : palette.text },
                          ]}
                          numberOfLines={1}
                        >
                          {col.name}
                        </Text>
                        <Text style={[styles.vesselCount, { color: palette.textSecondary }]}>
                          {t('inbox.collectionTileCount', { count })}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.vesselBadge,
                          {
                            backgroundColor: badgeBg,
                            borderColor: badgeBorder,
                          },
                        ]}
                      >
                        <Ionicons
                          name={badgeIcon}
                          size={14}
                          color={badgeTextColor}
                          style={styles.vesselBadgeIcon}
                        />
                        <Text
                          style={[
                            styles.vesselBadgeText,
                            { color: badgeTextColor },
                          ]}
                        >
                          {badgeLabel}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              }

              return (
                <Pressable
                  key={col.id}
                  testID={`merge-target-${col.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={col.name}
                  disabled={busy}
                  onPress={() => handleSelectTarget(col.id)}
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

          {targetLost ? (
            <View
              testID="merge-target-lost-notice"
              style={[
                styles.noticeBanner,
                { backgroundColor: palette.dangerSoft, borderColor: palette.danger },
              ]}
            >
              <Ionicons name="alert-circle" size={16} color={palette.danger} />
              <Text style={[styles.noticeBannerText, { color: palette.danger }]}>
                {t('folder.mergeTargetDisappearedNotice')}
              </Text>
            </View>
          ) : null}

          {selectedTarget ? (
            <View
              testID="merge-collections-notice"
              style={[
                styles.reassuranceCard,
                { backgroundColor: palette.mutedSurface, borderColor: palette.border },
              ]}
            >
              <View style={styles.reassuranceRow}>
                <Ionicons name="swap-horizontal" size={16} color={palette.accent} />
                <Text style={[styles.reassuranceText, { color: palette.text }]}>
                  {t('folder.mergeConsequenceNotice', {
                    sources: otherSourcesNames,
                    count: movingCount,
                    target: selectedTarget.name,
                  })}
                </Text>
              </View>
              <View style={styles.reassuranceRow}>
                <Ionicons name="shield-checkmark" size={16} color={palette.success} />
                <Text style={[styles.reassuranceSubText, { color: palette.textSecondary }]}>
                  {t('folder.mergePreservedNotice', { count: totalCount })}
                </Text>
              </View>
            </View>
          ) : null}

          {error ? (
            <View
              testID="merge-collections-error"
              style={[
                styles.noticeBanner,
                { backgroundColor: palette.dangerSoft, borderColor: palette.danger },
              ]}
            >
              <Ionicons name="alert-circle" size={16} color={palette.danger} />
              <Text style={[styles.noticeBannerText, { color: palette.danger }]}>{error}</Text>
            </View>
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
  vesselCard: {
    borderRadius: 14,
    padding: 12,
  },
  vesselCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  vesselIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vesselInfo: {
    flex: 1,
    gap: 2,
  },
  vesselName: {
    fontSize: 16,
    fontWeight: '700',
  },
  vesselCount: {
    fontSize: 13,
  },
  vesselBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  vesselBadgeIcon: {
    marginRight: 1,
  },
  vesselBadgeText: {
    fontSize: 12,
    fontWeight: '600',
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
  reassuranceCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 6,
  },
  reassuranceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  reassuranceText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  reassuranceSubText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  noticeBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
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
