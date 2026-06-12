import { Link, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/theme';
import { filterBookmarks } from '@/domain/search';
import { useBookmarks } from '@/store/bookmarks';
import type { Bookmark } from '@/domain/types';

function statusLabel(bookmark: Bookmark): string | null {
  const parts: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    parts.push(`sync ${bookmark.sync_status}`);
  }
  if (bookmark.metadata_status === 'pending') {
    parts.push('metadata pending');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function InboxScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { inbox, isLoading, loadError } = useBookmarks();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterBookmarks(inbox, query), [inbox, query]);
  const searching = query.trim().length > 0;

  return (
    <View style={styles.container}>
      {loadError ? (
        <Text style={[styles.errorBanner, { color: '#d93636', backgroundColor: palette.card }]}>
          Couldn’t open local storage — showing sample data. Your saves this session may not persist.
        </Text>
      ) : null}
      <View style={styles.searchWrap}>
        <TextInput
          style={[
            styles.searchInput,
            { backgroundColor: palette.card, color: palette.text },
          ]}
          placeholder="Search title, notes, or URL"
          placeholderTextColor={palette.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
        />
      </View>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            {searching ? `Matches (${visible.length})` : 'Recently saved'}
          </Text>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.textSecondary }]}>
            {isLoading
              ? 'Loading your bookmarks…'
              : searching
                ? 'No bookmarks match your search.'
                : 'Nothing saved yet. Add your first bookmark below.'}
          </Text>
        }
        renderItem={({ item }) => {
          const status = statusLabel(item);
          return (
            <Pressable
              style={[styles.card, { backgroundColor: palette.card }]}
              onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
            >
              <Text style={[styles.cardTitle, { color: palette.text }]}>
                {item.title ?? item.url ?? 'Untitled'}
              </Text>
              {item.url ? (
                <Text style={[styles.cardUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                  {item.url}
                </Text>
              ) : null}
              {status ? (
                <Text style={[styles.cardStatus, { color: palette.accent }]}>{status}</Text>
              ) : null}
            </Pressable>
          );
        }}
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
  empty: {
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: 32,
  },
  errorBanner: {
    fontSize: 13,
    paddingVertical: 10,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchInput: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 15,
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
  cardStatus: {
    fontSize: 12,
    fontWeight: '600',
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
