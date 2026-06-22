import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createApiKeysApi } from '@/api/api-keys';
import type { ApiKey } from '@/api/api-keys';
import { useI18n } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { useSupabaseAuth } from '@/supabase/auth-provider';

export default function ApiKeysScreen() {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const { t, formatDate } = useI18n();
  const auth = useSupabaseAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);

  const api =
    auth.status === 'authenticated' && auth.session
      ? createApiKeysApi(auth.session)
      : null;

  useEffect(() => {
    if (!api) return;
    let active = true;
    api
      .list()
      .then((data) => { if (active) setKeys(data); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  const handleCreate = async () => {
    if (!api || !newKeyName.trim() || creating) return;
    setCreating(true);
    try {
      const created = await api.create(newKeyName.trim());
      setKeys((prev) => [
        { id: created.id, name: created.name, created_at: created.created_at, last_used_at: null },
        ...prev,
      ]);
      setNewKeyName('');
      Alert.alert(
        t('apiKeys.created.title'),
        t('apiKeys.created.body', { key: created.key }),
        [
          {
            text: t('apiKeys.created.copy'),
            onPress: () => void Share.share({ message: created.key }),
          },
          { text: t('common.ok'), style: 'cancel' },
        ],
      );
    } catch {
      Alert.alert(t('apiKeys.error.createTitle'), t('apiKeys.error.createBody'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = (key: ApiKey) => {
    if (!api) return;
    Alert.alert(
      t('apiKeys.revoke.title'),
      t('apiKeys.revoke.body', { name: key.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('apiKeys.revoke.confirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.revoke(key.id);
              setKeys((prev) => prev.filter((k) => k.id !== key.id));
            } catch {
              Alert.alert(t('apiKeys.error.revokeTitle'), t('apiKeys.error.revokeBody'));
            }
          },
        },
      ],
    );
  };

  if (auth.status !== 'authenticated') {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>{t('apiKeys.requiresAuth')}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.description}>{t('apiKeys.description')}</Text>

      {/* Create new key */}
      <Card style={styles.createCard} elevated={false}>
        <TextInput
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
          placeholder={t('apiKeys.namePlaceholder')}
          placeholderTextColor={palette.textSecondary}
          value={newKeyName}
          onChangeText={setNewKeyName}
          onSubmitEditing={() => void handleCreate()}
          returnKeyType="done"
          maxLength={64}
        />
        <Button
          variant="primary"
          size="sm"
          onPress={() => void handleCreate()}
          disabled={!newKeyName.trim() || creating}
        >
          {creating ? t('apiKeys.creating') : t('apiKeys.create')}
        </Button>
      </Card>

      {/* Key list */}
      {loading ? (
        <ActivityIndicator color={palette.accent} style={styles.spinner} />
      ) : keys.length === 0 ? (
        <Text style={styles.emptyText}>{t('apiKeys.empty')}</Text>
      ) : (
        <Card style={styles.listCard} elevated={false}>
          {keys.map((key, index) => (
            <View
              key={key.id}
              style={[styles.keyRow, index < keys.length - 1 && styles.divider]}
            >
              <View style={styles.keyInfo}>
                <Text style={styles.keyName} numberOfLines={1}>
                  {key.name}
                </Text>
                <Text style={styles.keyMeta}>
                  {key.last_used_at
                    ? t('apiKeys.lastUsed', { date: formatDate(key.last_used_at) })
                    : t('apiKeys.neverUsed')}
                </Text>
              </View>
              <Pressable
                onPress={() => handleRevoke(key)}
                accessibilityRole="button"
                accessibilityLabel={t('apiKeys.revokeA11y', { name: key.name })}
                style={({ pressed }) => [styles.revokeBtn, pressed && { opacity: 0.5 }]}
              >
                <Ionicons name="trash-outline" size={18} color={palette.textSecondary} />
              </Pressable>
            </View>
          ))}
        </Card>
      )}

      <Text style={styles.note}>{t('apiKeys.note')}</Text>
    </ScrollView>
  );
}

const makeStyles = (palette: ReturnType<typeof usePalette>) =>
  StyleSheet.create({
    container: {
      padding: 16,
      gap: 16,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    },
    description: {
      fontSize: 14,
      color: palette.textSecondary,
      lineHeight: 20,
    },
    createCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    input: {
      flex: 1,
      fontSize: 15,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 8,
    },
    listCard: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: 'hidden',
    },
    keyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 13,
      gap: 12,
    },
    keyInfo: {
      flex: 1,
      gap: 3,
    },
    keyName: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.text,
    },
    keyMeta: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    revokeBtn: {
      padding: 4,
    },
    spinner: {
      marginTop: 24,
    },
    emptyText: {
      fontSize: 14,
      color: palette.textSecondary,
      textAlign: 'center',
      marginTop: 8,
    },
    note: {
      fontSize: 13,
      color: palette.textSecondary,
      lineHeight: 18,
      marginTop: -4,
    },
  });
