import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

interface CreateCollectionDialogProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (name: string) => void;
  onClose: () => void;
}

/**
 * Minimal "name this collection" dialog: a single text input plus Cancel/
 * Create. No app screen had an existing simple text-input modal to match, so
 * this stays as plain as possible while reusing the app's existing modal
 * language — the centered card + dimmed backdrop from `ActionSheet`, and the
 * bordered text-input styling from `CollectionPicker`'s search/create row.
 * Presentation only: the caller owns creating the collection (see Folder
 * View's "New folder" tile in `app/index.tsx`, which calls the store's
 * `createCollection` — the same function `CollectionPicker`'s inline create
 * row in Bookmark Detail calls) and passes back `busy`/`error`.
 */
export function CreateCollectionDialog({
  visible,
  busy,
  error,
  onCreate,
  onClose,
}: CreateCollectionDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');

  // Start fresh every time the dialog opens, so a prior name/error never
  // flashes before the next open's own state settles.
  useEffect(() => {
    if (visible) {
      setName('');
    }
  }, [visible]);

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || busy) {
      return;
    }
    onCreate(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
        onPress={busy ? undefined : onClose}
      >
        {/* Swallow presses so tapping the card doesn't dismiss it. */}
        <Pressable
          style={[
            styles.card,
            { backgroundColor: palette.surfaceElevated, marginBottom: insets.bottom + 24 },
          ]}
          onPress={() => {}}
        >
          <Text style={[styles.title, { color: palette.text }]}>{t('inbox.newCollection')}</Text>
          <TextInput
            testID="create-collection-input"
            accessibilityLabel={t('inbox.newCollectionNamePlaceholder')}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
            placeholder={t('inbox.newCollectionNamePlaceholder')}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
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
          <View style={styles.actions}>
            <Pressable
              testID="create-collection-cancel"
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={[styles.button, { borderColor: palette.border }]}
            >
              <Text style={[styles.buttonLabel, { color: palette.text }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              testID="create-collection-submit"
              accessibilityRole="button"
              accessibilityLabel={t('inbox.newCollectionCreate')}
              disabled={busy || trimmed.length === 0}
              onPress={submit}
              style={[
                styles.button,
                styles.buttonPrimary,
                {
                  backgroundColor: palette.accent,
                  opacity: busy || trimmed.length === 0 ? 0.5 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={palette.accentForeground} size="small" />
              ) : (
                <Text style={[styles.buttonLabel, { color: palette.accentForeground }]}>
                  {t('inbox.newCollectionCreate')}
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
    maxWidth: 360,
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
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
