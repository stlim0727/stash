import { Linking, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

export function UpdateRequired() {
  const palette = usePalette();
  const t = useT();

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Text style={[styles.emoji]}>📦</Text>
      <Text style={[styles.title, { color: palette.text }]}>{t('update.title')}</Text>
      <Text style={[styles.body, { color: palette.textSecondary }]}>{t('update.body')}</Text>
      <Button onPress={() => void Linking.openURL('https://github.com/stlim0727/stash/releases/tag/dev')}>
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
