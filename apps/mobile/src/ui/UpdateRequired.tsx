import { Linking, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_UPDATE_URL } from '@/domain/app-config';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

export function UpdateRequired({ message, updateUrl }: { message?: string | null; updateUrl?: string | null }) {
  const palette = usePalette();
  const t = useT();
  const targetUrl = updateUrl?.trim() || DEFAULT_UPDATE_URL;

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Text style={styles.emoji}>📦</Text>
      <Text style={[styles.title, { color: palette.text }]}>{t('update.title')}</Text>
      <Text style={[styles.body, { color: palette.textSecondary }]}>{message?.trim() || t('update.body')}</Text>
      <Button onPress={() => void Linking.openURL(targetUrl)}>
        {t('update.button')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  emoji: {
    fontSize: 48,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
