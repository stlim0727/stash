import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { useBookmarks } from '@/store/bookmarks';

export default function ArchivedScreen() {
  const palette = usePalette();
  const router = useRouter();
  const t = useT();
  const { archived } = useBookmarks();

  return (
    <View style={styles.container}>
      <FlatList
        data={archived}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('archived.empty')}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, { backgroundColor: palette.card }]}
            onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
          >
            <Text style={[styles.cardTitle, { color: palette.text }]}>
              {item.title ?? item.url ?? t('common.untitled')}
            </Text>
            {item.url ? (
              <Text style={[styles.cardUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                {item.url}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    padding: 16,
    gap: 12,
  },
  empty: {
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  cardUrl: {
    fontSize: 13,
  },
});
