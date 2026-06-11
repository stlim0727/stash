import { Link, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';

// Static placeholders until Milestone 2 introduces domain types and mock data.
const placeholderBookmarks = [
  {
    id: 'placeholder-1',
    title: 'Welcome to Stash',
    url: 'https://example.com/welcome',
  },
  {
    id: 'placeholder-2',
    title: 'Save links from any app',
    url: 'https://example.com/share-intake',
  },
];

export default function InboxScreen() {
  const palette = usePalette();
  const router = useRouter();

  return (
    <View style={styles.container}>
      <FlatList
        data={placeholderBookmarks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            Recently saved
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, { backgroundColor: palette.card }]}
            onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
          >
            <Text style={[styles.cardTitle, { color: palette.text }]}>{item.title}</Text>
            <Text style={[styles.cardUrl, { color: palette.textSecondary }]} numberOfLines={1}>
              {item.url}
            </Text>
          </Pressable>
        )}
      />
      <View style={[styles.footer, { borderTopColor: palette.border }]}>
        <Link href="/add" asChild>
          <Pressable style={[styles.primaryButton, { backgroundColor: palette.accent }]}>
            <Text style={styles.primaryButtonLabel}>Add Bookmark</Text>
          </Pressable>
        </Link>
        <Link href="/settings" asChild>
          <Pressable style={styles.secondaryButton}>
            <Text style={[styles.secondaryButtonLabel, { color: palette.accent }]}>Settings</Text>
          </Pressable>
        </Link>
      </View>
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
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
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
  footer: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
