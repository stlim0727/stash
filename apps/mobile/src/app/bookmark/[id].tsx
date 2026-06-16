import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { hostFromUrl } from '@/domain/item-icon';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import type { SuggestedTag } from '@/domain/types';
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
    requestAiEnrichment,
    acceptSuggestedTags,
    assignCollection,
    createCollection,
  } = useBookmarks();

  const [tagInput, setTagInput] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Suggested tag names the user dismissed this session (local-only).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
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

  // AI suggestions: surface only high-confidence tags not already applied
  // (centralized in @/domain/ai-suggestions) and not dismissed this session,
  // plus a collection that differs from where the bookmark currently lives.
  const appliedTagNames = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const pending = pendingSuggestions(enrichment, appliedTagNames).filter(
    (suggestion) => !dismissed.has(suggestion.name.toLowerCase()),
  );
  const suggestedCollection = getCollection(enrichment?.suggested_collection_id ?? null);
  const showCollectionSuggestion =
    !!suggestedCollection && bookmark.collection_id !== suggestedCollection.id;

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

  // One tidy "Details" section instead of a card per field. Only rows with a
  // real value show, so a sparse bookmark doesn't render mostly-empty cards.
  const details = [
    bookmark.url ? { label: 'URL', value: bookmark.url } : null,
    bookmark.site_name ? { label: 'Site', value: bookmark.site_name } : null,
    bookmark.description ? { label: 'Description', value: bookmark.description } : null,
    { label: 'Saved', value: new Date(bookmark.created_at).toLocaleString() },
    bookmark.source_app ? { label: 'From', value: bookmark.source_app } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  // Sync/metadata are de-emphasized: only surfaced as small chips when they
  // are noteworthy (not yet synced / still enriching), never as full cards.
  const statusChips: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    statusChips.push(`sync ${bookmark.sync_status}`);
  }
  if (bookmark.metadata_status !== 'complete') {
    statusChips.push(`metadata ${bookmark.metadata_status}`);
  }

  const host = hostFromUrl(bookmark.url);

  const handleShare = () => {
    if (!bookmark.url) {
      return;
    }
    void Share.share({ message: bookmark.url, url: bookmark.url, title: bookmark.title ?? undefined }).catch(
      () => {
        setOrganizeError('Could not open the share sheet.');
      },
    );
  };

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

  const handleSuggestAi = () => runOrganizeAction(() => requestAiEnrichment(bookmark.id));

  const handleAcceptTags = (items: SuggestedTag[]) =>
    runOrganizeAction(() => acceptSuggestedTags(bookmark.id, items));

  const handleDismissTag = (name: string) =>
    setDismissed((prev) => new Set(prev).add(name.toLowerCase()));

  const handleAcceptCollection = () => {
    if (suggestedCollection) {
      assignCollection(bookmark.id, suggestedCollection.id);
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
    <ScrollView style={{ backgroundColor: palette.background }} contentContainerStyle={styles.container}>
      {bookmark.preview_image_url ? (
        <Image
          source={{ uri: bookmark.preview_image_url }}
          style={styles.preview}
          resizeMode="cover"
        />
      ) : null}
      <Card style={styles.header}>
        <View style={styles.headerTop}>
          {bookmark.favicon_url ? (
            <View style={[styles.faviconTile, { borderColor: palette.border }]}>
              <Image source={{ uri: bookmark.favicon_url }} style={styles.favicon} resizeMode="contain" />
            </View>
          ) : null}
          <View style={styles.headerText}>
            <Text style={[styles.headerTitle, { color: palette.text }]} numberOfLines={3}>
              {bookmark.title ?? bookmark.url ?? 'Untitled'}
            </Text>
            {host ? (
              <Text style={[styles.headerHost, { color: palette.textSecondary }]} numberOfLines={1}>
                {host}
              </Text>
            ) : null}
          </View>
        </View>
        {statusChips.length > 0 ? (
          <View style={styles.statusRow}>
            {statusChips.map((label) => (
              <View key={label} style={[styles.statusChip, { backgroundColor: palette.mutedSurface }]}>
                <Text style={[styles.statusChipLabel, { color: palette.textSecondary }]}>{label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      <View style={styles.actionBar}>
        {bookmark.url ? (
          <ActionButton glyph="↗" label="Open" tint={palette.accent} onPress={handleOpenLink} />
        ) : null}
        {bookmark.url ? (
          <ActionButton glyph="⇪" label="Share" tint={palette.text} onPress={handleShare} />
        ) : null}
        <ActionButton
          glyph={bookmark.is_archived ? '↩' : '▾'}
          label={bookmark.is_archived ? 'Unarchive' : 'Archive'}
          tint={palette.text}
          onPress={() => archiveBookmark(bookmark.id, !bookmark.is_archived)}
        />
        <ActionButton glyph="✕" label="Delete" tint={palette.danger} onPress={handleDelete} />
      </View>

      <Card elevated={false} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Title</Text>
        <TextInput
          style={[styles.editInput, { color: palette.text, borderColor: palette.border }]}
          placeholder="Untitled — metadata pending"
          placeholderTextColor={palette.textSecondary}
          value={titleValue}
          onChangeText={setDraftTitle}
        />
      </Card>

      <Card elevated={false} style={styles.field}>
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
      </Card>

      {editsDirty ? <Button onPress={handleSaveEdits}>Save changes</Button> : null}

      <Card elevated={false} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Details</Text>
        {details.map((row, index) => (
          <View
            key={row.label}
            style={[
              styles.detailRow,
              index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null,
            ]}
          >
            <Text style={[styles.detailLabel, { color: palette.textSecondary }]}>{row.label}</Text>
            <Text style={[styles.detailValue, { color: palette.text }]} selectable>
              {row.value}
            </Text>
          </View>
        ))}
      </Card>

      <Card elevated={false} style={styles.field}>
        <View style={styles.suggestHeader}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>AI suggestions</Text>
          {enrichment?.model ? (
            <View style={[styles.aiBadge, { borderColor: palette.border }]}>
              <Text style={[styles.aiBadgeLabel, { color: palette.textSecondary }]}>
                {enrichment.model}
              </Text>
            </View>
          ) : null}
        </View>

        {enrichment?.status === 'stale' ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            These suggestions may be out of date since you edited this bookmark — refresh to update
            them.
          </Text>
        ) : null}

        {enrichment?.summary ? (
          <Text style={[styles.fieldValue, { color: palette.text }]}>{enrichment.summary}</Text>
        ) : null}

        {pending.length > 0 ? (
          <>
            <View style={styles.chipRow}>
              {pending.map((suggestion) => (
                <View
                  key={suggestion.name}
                  style={[styles.chip, styles.tagChip, { borderColor: palette.accent }]}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Accept suggested tag ${suggestion.name}`}
                    disabled={busy}
                    onPress={() => void handleAcceptTags([suggestion])}
                  >
                    <Text style={[styles.chipLabel, { color: palette.accent }]}>
                      ＋ {suggestion.name}
                    </Text>
                  </Pressable>
                  <Text style={[styles.confidence, { color: palette.textSecondary }]}>
                    {Math.round(suggestion.confidence * 100)}%
                  </Text>
                  <Pressable
                    accessibilityLabel={`Dismiss suggested tag ${suggestion.name}`}
                    disabled={busy}
                    hitSlop={6}
                    onPress={() => handleDismissTag(suggestion.name)}
                  >
                    <Text style={[styles.chipRemove, { color: palette.textSecondary }]}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {pending.length > 1 ? (
              <Pressable disabled={busy} onPress={() => void handleAcceptTags(pending)}>
                <Text style={[styles.link, { color: palette.accent }]}>Accept all tags</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {suggestedCollection && bookmark.collection_id !== suggestedCollection.id ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`File into ${suggestedCollection.name}`}
            disabled={busy}
            onPress={handleAcceptCollection}
          >
            <Text style={[styles.link, { color: palette.accent }]}>
              Suggested collection: file into “{suggestedCollection.name}”
            </Text>
          </Pressable>
        ) : null}

        {canOrganizeRemotely ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={[styles.suggestButton, { borderColor: palette.border }]}
            onPress={() => void handleSuggestAi()}
          >
            <Text style={[styles.actionLabel, { color: palette.accent }]}>
              {enrichment ? 'Refresh AI suggestions' : 'Suggest with AI'}
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            AI suggestions are available once this bookmark has synced.
          </Text>
        )}

        {enrichment && pending.length === 0 && !showCollectionSuggestion ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            No new suggestions right now.
          </Text>
        ) : null}
      </Card>

      <Card elevated={false} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Tags</Text>
        {tags.length > 0 ? (
          <View style={styles.chipRow}>
            {tags.map((tag) => (
              <View
                key={tag.id}
                style={[styles.chip, styles.tagChip, { borderColor: palette.border }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Browse #${tag.name}`}
                  onPress={() => router.navigate({ pathname: '/', params: { tag: tag.id } })}
                >
                  <Text style={[styles.chipLabel, { color: palette.text }]}>{tag.name}</Text>
                </Pressable>
                {canOrganizeRemotely ? (
                  <Pressable
                    accessibilityLabel={`Remove tag ${tag.name}`}
                    disabled={busy}
                    hitSlop={6}
                    onPress={() =>
                      void runOrganizeAction(() => removeTagFromBookmark(bookmark.id, tag.name))
                    }
                  >
                    <Text style={[styles.chipRemove, { color: palette.textSecondary }]}>×</Text>
                  </Pressable>
                ) : null}
              </View>
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
      </Card>

      <Card elevated={false} style={styles.field}>
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
      </Card>

      {organizeError ? <Text style={styles.error}>{organizeError}</Text> : null}
    </ScrollView>
  );
}

/** One item in the detail action bar: a glyph above a small label. */
function ActionButton({
  glyph,
  label,
  tint,
  onPress,
}: {
  glyph: string;
  label: string;
  tint: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: palette.card, borderColor: palette.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.actionGlyph, { color: tint }]}>{glyph}</Text>
      <Text style={[styles.actionBtnLabel, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 14,
  },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: 28,
  },
  header: {
    gap: 12,
    padding: 18,
    borderRadius: 24,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  faviconTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  favicon: {
    width: '70%',
    height: '70%',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  headerHost: {
    fontSize: 14,
    fontWeight: '500',
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusChip: {
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  statusChipLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  actionBar: {
    flexDirection: 'row',
    gap: 10,
  },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionGlyph: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '600',
  },
  actionBtnLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  detailRow: {
    paddingVertical: 10,
    gap: 2,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailValue: {
    fontSize: 15,
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
    borderRadius: 22,
    padding: 18,
    gap: 10,
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
  suggestHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  aiBadgeLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  confidence: {
    fontSize: 11,
    fontWeight: '600',
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
  },
  suggestButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chipRemove: {
    fontSize: 16,
    fontWeight: '600',
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
  error: {
    color: '#d93636',
    fontSize: 13,
    textAlign: 'center',
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
