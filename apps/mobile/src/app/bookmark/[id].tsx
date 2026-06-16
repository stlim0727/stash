import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ComponentProps } from 'react';
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
import { Card } from '@/ui/Card';
import { CollectionPicker } from '@/ui/CollectionPicker';
import { TagField } from '@/ui/TagField';
import { hostFromUrl } from '@/domain/item-icon';
import { pendingSuggestions } from '@/domain/ai-suggestions';
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

  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Suggested tag names the user dismissed this session (local-only).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // null = not editing; a string = the in-progress draft (auto-saved on blur).
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

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

  const notesValue = draftNotes ?? bookmark.notes ?? '';

  // Auto-save on blur: edit in place, no explicit "Save" button.
  const commitTitle = () => {
    if (draftTitle !== null && draftTitle.trim() !== (bookmark.title ?? '')) {
      updateBookmarkFields(bookmark.id, { title: draftTitle.trim() });
    }
    setDraftTitle(null);
  };
  const commitNotes = () => {
    if (draftNotes !== null && draftNotes !== (bookmark.notes ?? '')) {
      updateBookmarkFields(bookmark.id, { notes: draftNotes });
    }
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
    void Share.share({
      message: bookmark.url,
      url: bookmark.url,
      title: bookmark.title ?? undefined,
    }).catch(() => {
      setOrganizeError('Could not open the share sheet.');
    });
  };

  const runOrganizeAction = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setOrganizeError(null);
    const error = await action();
    setOrganizeError(error);
    setBusy(false);
    return error === null;
  };

  const handleAddTag = (name: string) =>
    runOrganizeAction(() => addTagsToBookmark(bookmark.id, [name]));
  const handleRemoveTag = (name: string) =>
    void runOrganizeAction(() => removeTagFromBookmark(bookmark.id, name));
  const handleAcceptSuggestion = (name: string) => {
    const match = pending.find((suggestion) => suggestion.name === name);
    if (match) {
      void runOrganizeAction(() => acceptSuggestedTags(bookmark.id, [match]));
    }
  };
  const handleDismissTag = (name: string) =>
    setDismissed((prev) => new Set(prev).add(name.toLowerCase()));

  const handleSuggestAi = () => void runOrganizeAction(() => requestAiEnrichment(bookmark.id));

  const handleAcceptCollection = () => {
    if (suggestedCollection) {
      assignCollection(bookmark.id, suggestedCollection.id);
    }
  };

  const handleCreateCollection = (name: string) =>
    runOrganizeAction(async () => {
      const result = await createCollection(name);
      if (result.collection) {
        assignCollection(bookmark.id, result.collection.id);
        return null;
      }
      return result.error ?? 'Could not create the collection.';
    });

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
      {/* Compact byline: favicon · host · status, instead of a header card. */}
      <View style={styles.byline}>
        {bookmark.favicon_url ? (
          <View style={[styles.bylineFavTile, { borderColor: palette.border }]}>
            <Image source={{ uri: bookmark.favicon_url }} style={styles.bylineFav} resizeMode="contain" />
          </View>
        ) : null}
        <Text style={[styles.bylineText, { color: palette.textSecondary }]} numberOfLines={1}>
          {host ?? 'Saved'}
          {statusChips.length > 0 ? `  ·  ${statusChips.join(' · ')}` : ''}
        </Text>
      </View>

      {/* Title — tap to edit in place, auto-saved on blur. */}
      {draftTitle === null ? (
        <Pressable accessibilityRole="button" onPress={() => setDraftTitle(bookmark.title ?? '')}>
          <Text style={[styles.title, { color: palette.text }]}>
            {bookmark.title ?? bookmark.url ?? 'Untitled'}
          </Text>
        </Pressable>
      ) : (
        <TextInput
          accessibilityLabel="Edit title"
          autoFocus
          multiline
          style={[styles.title, styles.titleInput, { color: palette.text, borderColor: palette.border }]}
          placeholder="Untitled — metadata pending"
          placeholderTextColor={palette.textSecondary}
          value={draftTitle}
          onChangeText={setDraftTitle}
          onBlur={commitTitle}
        />
      )}

      <View style={styles.actionBar}>
        {bookmark.url ? (
          <ActionButton icon="open-outline" label="Open" tint={palette.accent} onPress={handleOpenLink} />
        ) : null}
        {bookmark.url ? (
          <ActionButton icon="share-social" label="Share" tint={palette.text} onPress={handleShare} />
        ) : null}
        <ActionButton
          icon={bookmark.is_archived ? 'arrow-undo' : 'archive'}
          label={bookmark.is_archived ? 'Unarchive' : 'Archive'}
          tint={palette.text}
          onPress={() => archiveBookmark(bookmark.id, !bookmark.is_archived)}
        />
        <ActionButton icon="trash" label="Delete" tint={palette.danger} onPress={handleDelete} />
      </View>

      {/* Notes — borderless, label-less, auto-saved on blur. */}
      <TextInput
        accessibilityLabel="Notes"
        style={[
          styles.notesInput,
          { color: palette.text, backgroundColor: palette.surface, borderColor: palette.border },
        ]}
        placeholder="Add a note…"
        placeholderTextColor={palette.textSecondary}
        multiline
        value={notesValue}
        onChangeText={setDraftNotes}
        onBlur={commitNotes}
      />

      <Card elevated={false} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Tags</Text>
        <TagField
          tags={tags.map((tag) => ({ id: tag.id, name: tag.name }))}
          suggestions={pending.map((suggestion) => ({
            name: suggestion.name,
            confidence: suggestion.confidence,
          }))}
          editable={canOrganizeRemotely}
          busy={busy}
          onAdd={handleAddTag}
          onRemove={handleRemoveTag}
          onBrowse={(tagId) => router.navigate({ pathname: '/', params: { tag: tagId } })}
          onAcceptSuggestion={handleAcceptSuggestion}
          onDismissSuggestion={handleDismissTag}
          disabledHint={
            canOrganizeRemotely ? undefined : 'Tags can be edited once this bookmark has synced.'
          }
        />
      </Card>

      <Card elevated={false} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Collection</Text>
        <CollectionPicker
          collections={collections.map((item) => ({ id: item.id, name: item.name }))}
          currentId={bookmark.collection_id}
          currentName={collection?.name ?? null}
          busy={busy}
          onSelect={(value) => assignCollection(bookmark.id, value)}
          onCreate={handleCreateCollection}
        />
        {collection && !collections.some((item) => item.id === collection.id) ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            Currently in: {collection.name}
          </Text>
        ) : null}
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
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            Suggested tags are in the Tags field above — tap a “＋” chip to add.
          </Text>
        ) : null}

        {showCollectionSuggestion ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`File into ${suggestedCollection!.name}`}
            disabled={busy}
            onPress={handleAcceptCollection}
          >
            <Text style={[styles.link, { color: palette.accent }]}>
              Suggested collection: file into “{suggestedCollection!.name}”
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

      <View style={styles.detailsSection}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle details"
          onPress={() => setShowDetails((value) => !value)}
          style={styles.detailsToggle}
        >
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
            {showDetails ? '▾  Details' : '▸  Details'}
          </Text>
        </Pressable>
        {showDetails ? (
          <Card elevated={false} style={styles.field}>
            {details.map((row, index) => (
              <View
                key={row.label}
                style={[
                  styles.detailRow,
                  index > 0
                    ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }
                    : null,
                ]}
              >
                <Text style={[styles.detailLabel, { color: palette.textSecondary }]}>{row.label}</Text>
                <Text style={[styles.detailValue, { color: palette.text }]} selectable>
                  {row.value}
                </Text>
              </View>
            ))}
          </Card>
        ) : null}
      </View>

      {organizeError ? <Text style={styles.error}>{organizeError}</Text> : null}
    </ScrollView>
  );
}

/** One item in the detail action bar: a vector icon above a small label. */
function ActionButton({
  icon,
  label,
  tint,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
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
      <Ionicons name={icon} size={22} color={tint} />
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
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bylineFavTile: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  bylineFav: {
    width: '72%',
    height: '72%',
  },
  bylineText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  titleInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  detailsSection: {
    gap: 8,
  },
  detailsToggle: {
    paddingVertical: 4,
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
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 64,
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
