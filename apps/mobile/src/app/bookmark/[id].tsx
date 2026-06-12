import { useLocalSearchParams } from 'expo-router';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { useBookmarks } from '@/store/bookmarks';

export default function BookmarkDetailScreen() {
  const palette = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getBookmark, getTagsForBookmark, getCollection, getEnrichment } = useBookmarks();

  const bookmark = id ? getBookmark(id) : undefined;

  if (!bookmark) {
    return (
      <View style={styles.missing}>
        <Text style={[styles.missingText, { color: palette.textSecondary }]}>
          This bookmark could not be found.
        </Text>
      </View>
    );
  }

  const tags = getTagsForBookmark(bookmark.id);
  const collection = getCollection(bookmark.collection_id);
  const enrichment = getEnrichment(bookmark.id);

  const fields = [
    { label: 'URL', value: bookmark.url ?? 'No URL (text-only share)' },
    { label: 'Title', value: bookmark.title ?? 'Untitled — metadata pending' },
    { label: 'Description', value: bookmark.description ?? 'No description yet' },
    { label: 'Notes', value: bookmark.notes ?? 'No notes' },
    {
      label: 'Tags',
      value: tags.length > 0 ? tags.map((tag) => tag.name).join(', ') : 'None yet',
    },
    { label: 'Collection', value: collection?.name ?? 'Inbox (no collection)' },
    { label: 'Site', value: bookmark.site_name ?? 'Unknown' },
    { label: 'Saved from', value: bookmark.source_app ?? 'Manual entry' },
    { label: 'Metadata status', value: bookmark.metadata_status },
    { label: 'Sync status', value: bookmark.sync_status },
    { label: 'Saved at', value: new Date(bookmark.created_at).toLocaleString() },
  ];

  if (enrichment?.summary) {
    fields.push({ label: 'AI summary', value: enrichment.summary });
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {bookmark.preview_image_url ? (
        <Image
          source={{ uri: bookmark.preview_image_url }}
          style={styles.preview}
          resizeMode="cover"
        />
      ) : null}
      <View style={styles.header}>
        {bookmark.favicon_url ? (
          <Image source={{ uri: bookmark.favicon_url }} style={styles.favicon} />
        ) : null}
        <Text style={[styles.headerTitle, { color: palette.text }]} numberOfLines={2}>
          {bookmark.title ?? bookmark.url ?? 'Untitled'}
        </Text>
      </View>
      {fields.map((field) => (
        <View key={field.label} style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>{field.label}</Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>{field.value}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Text style={[styles.actionPlaceholder, { color: palette.textSecondary }]}>
          Archive and delete actions arrive in Milestone 10.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  preview: {
    width: '100%',
    height: 180,
    borderRadius: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  favicon: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
  },
  missing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  missingText: {
    fontSize: 15,
    textAlign: 'center',
  },
  field: {
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 15,
  },
  actions: {
    paddingVertical: 8,
  },
  actionPlaceholder: {
    fontSize: 13,
    textAlign: 'center',
  },
});
