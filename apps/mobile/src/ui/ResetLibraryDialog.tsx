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

interface ResetLibraryDialogProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Type-to-confirm dialog for the destructive library reset (issue #600).
 * Follows `CreateCollectionDialog`'s modal language (centered card + dimmed
 * backdrop), but the confirm button stays disabled until the user types the
 * localized confirm word exactly — a stronger gate than a two-button alert for
 * an action that deletes every bookmark in the account. Presentation only:
 * the caller owns running the reset and passes back `busy`/`error`.
 */
export function ResetLibraryDialog({
  visible,
  busy,
  error,
  onConfirm,
  onClose,
}: ResetLibraryDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState('');

  // Start fresh every open so a prior confirmation never carries over.
  useEffect(() => {
    if (visible) {
      setTyped('');
    }
  }, [visible]);

  const confirmWord = t('settings.reset.confirmWord');
  const confirmed = typed.trim() === confirmWord;
  const submit = () => {
    if (!confirmed || busy) {
      return;
    }
    onConfirm();
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
          <Text style={[styles.title, { color: palette.text }]}>
            {t('settings.reset.dialogTitle')}
          </Text>
          <Text style={[styles.body, { color: palette.textSecondary }]}>
            {t('settings.reset.dialogBody')}
          </Text>
          <Text style={[styles.body, { color: palette.text }]}>
            {t('settings.reset.typeToConfirm', { word: confirmWord })}
          </Text>
          <TextInput
            testID="reset-library-input"
            accessibilityLabel={t('settings.reset.typeToConfirm', { word: confirmWord })}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
            placeholder={confirmWord}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            editable={!busy}
            value={typed}
            onChangeText={setTyped}
            returnKeyType="done"
            onSubmitEditing={submit}
          />
          {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              testID="reset-library-cancel"
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
              testID="reset-library-submit"
              accessibilityRole="button"
              accessibilityLabel={t('settings.reset.confirm')}
              disabled={busy || !confirmed}
              onPress={submit}
              style={[
                styles.button,
                styles.buttonPrimary,
                {
                  backgroundColor: palette.danger,
                  opacity: busy || !confirmed ? 0.5 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={[styles.buttonLabel, { color: '#ffffff' }]}>
                  {t('settings.reset.confirm')}
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
  body: {
    fontSize: 13,
    lineHeight: 18,
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
