import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

export interface BulkTagDialogProps {
  visible: boolean;
  selectedCount: number;
  existingTags: Array<{ id: string; name: string; count?: number }>;
  busy: boolean;
  error: string | null;
  onApplyTag: (tagName: string) => void;
  onClose: () => void;
}

export function BulkTagDialog({
  visible,
  selectedCount,
  existingTags,
  busy,
  error,
  onApplyTag,
  onClose,
}: BulkTagDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');

  useEffect(() => {
    if (visible) {
      setName('');
    }
  }, [visible]);

  const cleanInput = name.trim().replace(/^#+/, '');

  const matchingTags = useMemo(() => {
    const query = cleanInput.toLowerCase();
    if (!query) {
      return existingTags.slice(0, 16);
    }
    return existingTags
      .filter((tag) => tag.name.toLowerCase().includes(query))
      .slice(0, 16);
  }, [cleanInput, existingTags]);

  const submit = () => {
    if (!cleanInput || busy) {
      return;
    }
    onApplyTag(cleanInput);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
        onPress={busy ? undefined : onClose}
      >
        {/* Swallow presses so tapping the card doesn't dismiss it */}
        <Pressable
          testID="bulk-tag-dialog"
          style={[
            styles.card,
            { backgroundColor: palette.surfaceElevated, marginBottom: insets.bottom + 24 },
          ]}
          onPress={() => {}}
        >
          <Text testID="bulk-tag-title" style={[styles.title, { color: palette.text }]}>
            {t('inbox.bulkTagTitle', { count: selectedCount })}
          </Text>

          <TextInput
            testID="bulk-tag-input"
            accessibilityLabel={t('inbox.bulkTagPlaceholder')}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
            placeholder={t('inbox.bulkTagPlaceholder')}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!busy}
            value={name}
            onChangeText={setName}
            returnKeyType="done"
            onSubmitEditing={submit}
          />

          {error ? (
            <Text style={[styles.error, { color: palette.danger }]}>{error}</Text>
          ) : null}

          {matchingTags.length > 0 ? (
            <View style={styles.suggestionsSection}>
              <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
                {t('inbox.bulkTagExistingTags')}
              </Text>
              <ScrollView
                style={styles.chipScrollView}
                contentContainerStyle={styles.chipContainer}
                keyboardShouldPersistTaps="handled"
              >
                {matchingTags.map((tag) => (
                  <Pressable
                    key={tag.id || tag.name}
                    testID={`bulk-tag-chip-${tag.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.bulkTagApplyA11y', { name: tag.name })}
                    disabled={busy}
                    onPress={() => onApplyTag(tag.name)}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: palette.text }]}>
                      #{tag.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              testID="bulk-tag-cancel"
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={[styles.button, { borderColor: palette.border }]}
            >
              <Text style={[styles.buttonLabel, { color: palette.text }]}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Pressable
              testID="bulk-tag-submit"
              accessibilityRole="button"
              accessibilityLabel={t('inbox.bulkTagSubmit')}
              disabled={busy || cleanInput.length === 0}
              onPress={submit}
              style={[
                styles.button,
                styles.buttonPrimary,
                {
                  backgroundColor: palette.accent,
                  opacity: busy || cleanInput.length === 0 ? 0.5 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={palette.accentForeground} size="small" />
              ) : (
                <Text style={[styles.buttonLabel, { color: palette.accentForeground }]}>
                  {t('inbox.bulkTagSubmit')}
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
    maxWidth: 380,
    borderRadius: 18,
    padding: 18,
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  error: {
    fontSize: 13,
    fontWeight: '500',
  },
  suggestionsSection: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  chipScrollView: {
    maxHeight: 120,
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 2,
  },
  chip: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
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
    fontWeight: '600',
  },
});
