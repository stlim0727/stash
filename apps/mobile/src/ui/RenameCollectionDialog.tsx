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

export interface RenameCollectionDialogProps {
  visible: boolean;
  busy: boolean;
  error: string | null;
  initialName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}

export function RenameCollectionDialog({
  visible,
  busy,
  error,
  initialName,
  onRename,
  onClose,
}: RenameCollectionDialogProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (visible) {
      setName(initialName);
    }
  }, [visible, initialName]);

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || busy) {
      return;
    }
    onRename(trimmed);
  };

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
          <Text style={[styles.title, { color: palette.text }]}>{t('folder.renameTitle')}</Text>
          <TextInput
            testID="rename-collection-input"
            accessibilityLabel={t('folder.renameNamePlaceholder')}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
            placeholder={t('folder.renameNamePlaceholder')}
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
              testID="rename-collection-cancel"
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={[styles.button, { borderColor: palette.border }]}
            >
              <Text style={[styles.buttonLabel, { color: palette.text }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              testID="rename-collection-submit"
              accessibilityRole="button"
              accessibilityLabel={t('folder.renameSave')}
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
                  {t('folder.renameSave')}
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
