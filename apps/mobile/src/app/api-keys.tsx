import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
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
import { getSupabaseConfigState } from '@/supabase/config';

function getPublicApiBase(): string {
  const state = getSupabaseConfigState();
  if (state.status !== 'configured') return '';
  return `${state.config.url}/functions/v1/public-api`;
}

export default function ApiKeysScreen() {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const { t, formatDate } = useI18n();
  const auth = useSupabaseAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const publicApiBase = getPublicApiBase();
  const openApiUrl = publicApiBase ? `${publicApiBase}/openapi.json` : '';

  useEffect(() => {
    let active = true;
    auth.ensureAnonymousSession().then((session) => {
      if (!active || !session) return;
      createApiKeysApi(session)
        .list()
        .then((data) => { if (active) setKeys(data); })
        .catch(() => {})
        .finally(() => { if (active) setLoading(false); });
    }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  const handleCopy = async (text: string, id: string) => {
    await Clipboard.setStringAsync(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
  };

  const handleCreate = async () => {
    if (!newKeyName.trim() || creating) return;
    setCreating(true);
    try {
      const session = await auth.ensureAnonymousSession();
      if (!session) throw new Error('No session');
      const freshApi = createApiKeysApi(session);
      const created = await freshApi.create(newKeyName.trim());
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
            onPress: () => void handleCopy(created.key, created.id),
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
              const session = await auth.ensureAnonymousSession();
              if (!session) throw new Error('No session');
              await createApiKeysApi(session).revoke(key.id);
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

      {/* How to use guide */}
      <Card style={styles.guideCard} elevated={false}>
        <Text style={styles.guideTitle}>{t('apiKeys.guide.title')}</Text>
        {(['1', '2', '3'] as const).map((n) => (
          <View key={n} style={styles.guideStep}>
            <View style={styles.guideBadge}>
              <Text style={styles.guideBadgeText}>{n}</Text>
            </View>
            <Text style={styles.guideStepText}>
              {t(`apiKeys.guide.step${n}` as 'apiKeys.guide.step1')}
            </Text>
          </View>
        ))}
        {openApiUrl ? (
          <Pressable
            style={({ pressed }) => [styles.urlRow, pressed && { opacity: 0.6 }]}
            onPress={() => void handleCopy(openApiUrl, 'openapi-url')}
            accessibilityRole="button"
            accessibilityLabel={t('apiKeys.guide.copyUrlA11y')}
          >
            <Text style={styles.urlText} numberOfLines={1} ellipsizeMode="middle">
              {openApiUrl}
            </Text>
            <Ionicons
              name={copiedId === 'openapi-url' ? 'checkmark' : 'copy-outline'}
              size={15}
              color={copiedId === 'openapi-url' ? palette.accent : palette.textSecondary}
            />
          </Pressable>
        ) : null}
      </Card>

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
                style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
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
    guideCard: {
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    guideTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.text,
      marginBottom: 2,
    },
    guideStep: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    guideBadge: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
      flexShrink: 0,
    },
    guideBadgeText: {
      fontSize: 11,
      fontWeight: '700',
      color: '#fff',
    },
    guideStepText: {
      flex: 1,
      fontSize: 13,
      color: palette.textSecondary,
      lineHeight: 19,
    },
    urlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: palette.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginTop: 2,
    },
    urlText: {
      flex: 1,
      fontSize: 12,
      color: palette.textSecondary,
      fontFamily: 'monospace' as const,
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
    iconBtn: {
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
