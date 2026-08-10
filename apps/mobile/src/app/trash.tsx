import { useRouter } from 'expo-router';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PostHogMaskView } from 'posthog-react-native';

import { displayTitle } from '@/domain/item-display';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { useBookmarks } from '@/store/bookmarks';

export default function TrashScreen() {
  const palette = usePalette();
  const router = useRouter();
  const t = useT();
  const { trash, restoreBookmark, emptyTrash } = useBookmarks();

  const handleEmptyTrash = () => {
    Alert.alert(
      t('trash.emptyTitle'),
      t('trash.emptyBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('trash.emptyConfirm'),
          style: 'destructive',
          onPress: () => {
            emptyTrash();
            router.back();
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <FlatList
        data={trash}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('trash.empty')}</Text>
        }
        ListFooterComponent={
          trash.length > 0 ? (
            <View style={styles.footer}>
              <Button variant="ghost" onPress={handleEmptyTrash}>
                {t('trash.emptyButton')}
              </Button>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, { backgroundColor: palette.card }]}
            onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
          >
            <PostHogMaskView style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: palette.text }]} numberOfLines={1}>
                {displayTitle(item) ?? t('common.untitled')}
              </Text>
              {item.url ? (
                <Text style={[styles.cardUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                  {item.url}
                </Text>
              ) : null}
            </PostHogMaskView>
            <Pressable
              style={styles.restore}
              accessibilityLabel={t('trash.restore')}
              onPress={() => restoreBookmark(item.id)}
            >
              <Text style={[styles.restoreText, { color: palette.accent }]}>{t('trash.restore')}</Text>
            </Pressable>
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
    gap: 10,
  },
  empty: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 48,
  },
  card: {
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardContent: {
    flex: 1,
    gap: 3,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  cardUrl: {
    fontSize: 13,
  },
  restore: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  restoreText: {
    fontSize: 13,
    fontWeight: '600',
  },
  footer: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 8,
  },
});
