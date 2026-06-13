import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { usePalette } from '@/theme';
import { useBookmarks } from '@/store/bookmarks';
import { hasRemoteIdentity } from '@/sync/sync-bookmarks';

export default function BookmarkDetailScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    getBookmark,
    getTagsForBookmark,
    getCollection,
    getEnrichment,
    archiveBookmark,
    updateBookmarkFields,
    deleteBookmark,
    collections,
    addTagsToBookmark,
    removeTagFromBookmark,
    assignCollection,
    createCollection,
  } = useBookmarks();

  const [tagInput, setTagInput] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = not editing; the live bookmark value shows until the user types.
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<string | null>(null);

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
  const canOrganizeRemotely = hasRemoteIdentity(bookmark.id);

  const titleValue = draftTitle ?? bookmark.title ?? '';
  const notesValue = draftNotes ?? bookmark.notes ?? '';
  const editsDirty =
    (draftTitle !== null && draftTitle !== (bookmark.title ?? '')) ||
    (draftNotes !== null && draftNotes !== (bookmark.notes ?? ''));

  const handleSaveEdits = () => {
    updateBookmarkFields(bookmark.id, {
      ...(draftTitle !== null ? { title: draftTitle } : {}),
      ...(draftNotes !== null ? { notes: draftNotes } : {}),
    });
    setDraftTitle(null);
    setDraftNotes(null);
  };

  const fields = [
    { label: 'URL', value: bookmark.url ?? 'No URL (text-only share)' },
    { label: 'Description', value: bookmark.description ?? 'No description yet' },
    { label: 'Site', value: bookmark.site_name ?? 'Unknown' },
    { label: 'Saved from', value: bookmark.source_app ?? 'Manual entry' },
    { label: 'Metadata status', value: bookmark.metadata_status },
    { label: 'Sync status', value: bookmark.sync_status },
    { label: 'Saved at', value: new Date(bookmark.created_at).toLocaleString() },
  ];

  if (enrichment?.summary) {
    fields.push({ label: 'AI summary', value: enrichment.summary });
  }

  const runOrganizeAction = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setOrganizeError(null);
    const error = await action();
    setOrganizeError(error);
    setBusy(false);
    return error === null;
  };

  const handleAddTag = async () => {
    const name = tagInput.trim();
    if (!name) {
      return;
    }
    const ok = await runOrganizeAction(() => addTagsToBookmark(bookmark.id, [name]));
    if (ok) {
      setTagInput('');
    }
  };

  const handleCreateCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) {
      return;
    }
    await runOrganizeAction(async () => {
      const result = await createCollection(name);
      if (result.collection) {
        assignCollection(bookmark.id, result.collection.id);
        setNewCollectionName('');
        return null;
      }
      return result.error ?? 'Could not create the collection.';
    });
  };

  const handleOpenLink = () => {
    if (bookmark.url) {
      void Linking.openURL(bookmark.url).catch(() => {
        setOrganizeError('Could not open this link.');
      });
    }
  };

  const handleDelete = () => {
    const remove = () => {
      deleteBookmark(bookmark.id);
      router.back();
    };
    if (Platform.OS === 'web') {
      // Alert.alert has no button support on web.
      if (typeof confirm === 'undefined' || confirm('Delete this bookmark permanently?')) {
        remove();
      }
      return;
    }
    Alert.alert('Delete bookmark', 'This permanently removes the bookmark from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: remove },
    ]);
  };

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
      {bookmark.url ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open link"
          style={[styles.openButton, { backgroundColor: palette.accent }]}
          onPress={handleOpenLink}
        >
          <Text style={styles.openButtonLabel}>Open link ↗</Text>
        </Pressable>
      ) : null}
      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Title</Text>
        <TextInput
          style={[styles.editInput, { color: palette.text, borderColor: palette.border }]}
          placeholder="Untitled — metadata pending"
          placeholderTextColor={palette.textSecondary}
          value={titleValue}
          onChangeText={setDraftTitle}
        />
      </View>

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Notes</Text>
        <TextInput
          style={[
            styles.editInput,
            styles.notesInput,
            { color: palette.text, borderColor: palette.border },
          ]}
          placeholder="No notes"
          placeholderTextColor={palette.textSecondary}
          multiline
          value={notesValue}
          onChangeText={setDraftNotes}
        />
      </View>

      {editsDirty ? (
        <Pressable
          style={[styles.saveButton, { backgroundColor: palette.accent }]}
          onPress={handleSaveEdits}
        >
          <Text style={styles.saveButtonLabel}>Save changes</Text>
        </Pressable>
      ) : null}

      {fields.map((field) => (
        <View key={field.label} style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>{field.label}</Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>{field.value}</Text>
        </View>
      ))}

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Tags</Text>
        {tags.length > 0 ? (
          <View style={styles.chipRow}>
            {tags.map((tag) => (
              <Pressable
                key={tag.id}
                disabled={busy || !canOrganizeRemotely}
                style={[styles.chip, { borderColor: palette.border }]}
                onPress={() => void runOrganizeAction(() => removeTagFromBookmark(bookmark.id, tag.name))}
              >
                <Text style={[styles.chipLabel, { color: palette.text }]}>
                  {tag.name}
                  {canOrganizeRemotely ? '  ×' : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={[styles.fieldValue, { color: palette.textSecondary }]}>None yet</Text>
        )}
        {canOrganizeRemotely ? (
          <View style={styles.inlineForm}>
            <TextInput
              style={[styles.inlineInput, { color: palette.text, borderColor: palette.border }]}
              placeholder="Add a tag"
              placeholderTextColor={palette.textSecondary}
              autoCapitalize="none"
              value={tagInput}
              onChangeText={setTagInput}
              onSubmitEditing={() => void handleAddTag()}
            />
            <Pressable
              disabled={busy}
              style={[styles.inlineButton, { backgroundColor: palette.accent }]}
              onPress={() => void handleAddTag()}
            >
              <Text style={styles.inlineButtonLabel}>Add</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            Tags can be edited once this bookmark has synced.
          </Text>
        )}
      </View>

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Collection</Text>
        <View style={styles.chipRow}>
          <Pressable
            disabled={busy}
            style={[
              styles.chip,
              { borderColor: palette.border },
              bookmark.collection_id === null && { backgroundColor: palette.border },
            ]}
            onPress={() => assignCollection(bookmark.id, null)}
          >
            <Text style={[styles.chipLabel, { color: palette.text }]}>Inbox (none)</Text>
          </Pressable>
          {collections.map((item) => (
            <Pressable
              key={item.id}
              disabled={busy}
              style={[
                styles.chip,
                { borderColor: palette.border },
                bookmark.collection_id === item.id && { backgroundColor: palette.border },
              ]}
              onPress={() => assignCollection(bookmark.id, item.id)}
            >
              <Text style={[styles.chipLabel, { color: palette.text }]}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
        {collection && !collections.some((item) => item.id === collection.id) ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            Currently in: {collection.name}
          </Text>
        ) : null}
        <View style={styles.inlineForm}>
          <TextInput
            style={[styles.inlineInput, { color: palette.text, borderColor: palette.border }]}
            placeholder="New collection"
            placeholderTextColor={palette.textSecondary}
            value={newCollectionName}
            onChangeText={setNewCollectionName}
            onSubmitEditing={() => void handleCreateCollection()}
          />
          <Pressable
            disabled={busy}
            style={[styles.inlineButton, { backgroundColor: palette.accent }]}
            onPress={() => void handleCreateCollection()}
          >
            <Text style={styles.inlineButtonLabel}>Create</Text>
          </Pressable>
        </View>
      </View>

      {organizeError ? <Text style={styles.error}>{organizeError}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          style={[styles.actionButton, { borderColor: palette.border }]}
          onPress={() => archiveBookmark(bookmark.id, !bookmark.is_archived)}
        >
          <Text style={[styles.actionLabel, { color: palette.accent }]}>
            {bookmark.is_archived ? 'Unarchive' : 'Archive'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.actionButton, { borderColor: palette.border }]}
          onPress={handleDelete}
        >
          <Text style={[styles.actionLabel, { color: '#d93636' }]}>Delete</Text>
        </Pressable>
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
    gap: 8,
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  inlineForm: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  inlineInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  inlineButton: {
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  inlineButtonLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
  },
  editInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  openButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  openButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  saveButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  saveButtonLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#d93636',
    fontSize: 13,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 8,
  },
  actionButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
