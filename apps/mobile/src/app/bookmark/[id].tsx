import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { enrichmentDegradedLabel, metadataStatusLabel, syncStatusLabel } from '@/i18n/status';
import { usePalette } from '@/theme';
import { Card } from '@/ui/Card';
import { CollectionPicker } from '@/ui/CollectionPicker';
import { SuggestionSkeleton } from '@/ui/SuggestionSkeleton';
import { TagField } from '@/ui/TagField';
import { hostFromUrl } from '@/domain/item-icon';
import { displayTitle } from '@/domain/item-display';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { hashtagSuggestions } from '@/domain/hashtags';
import { AI_RATE_LIMITED, useBookmarks } from '@/store/bookmarks';
import { hasRemoteIdentity } from '@/sync/sync-bookmarks';

// Lines of title shown before collapsing behind a "Show more" toggle.
const TITLE_COLLAPSED_LINES = 4;

export default function BookmarkDetailScreen() {
  const palette = usePalette();
  const { t, formatDate } = useI18n();
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
    isEnriching,
    isManuallyEnriching,
    acceptSuggestedTags,
    getReviewedSuggestions,
    markSuggestionsReviewed,
    clearReviewedSuggestions,
    assignCollection,
    createCollection,
  } = useBookmarks();

  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Suggested tag names the user dismissed this session (local-only).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Suggested collection id the user dismissed this session (local-only). A new
  // enrichment proposing a different collection re-surfaces the chip.
  const [dismissedCollectionId, setDismissedCollectionId] = useState<string | null>(null);
  // null = not editing; a string = the in-progress draft (auto-saved on blur).
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // Long titles (e.g. a full Instagram caption pasted as the title) are
  // collapsed to a few lines with a "Show more" toggle so they don't push the
  // rest of the screen out of view. null = not yet measured.
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [titleLineCount, setTitleLineCount] = useState<number | null>(null);
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  const insets = useSafeAreaInsets();

  // Auto-save drafts even when the screen is dismissed via the system back
  // button, which unmounts before a TextInput's onBlur fires. Refs hold the
  // latest values; the unmount effect flushes them to the store (no setState).
  const draftTitleRef = useRef<string | null>(null);
  const draftNotesRef = useRef<string | null>(null);
  draftTitleRef.current = draftTitle;
  draftNotesRef.current = draftNotes;
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => () => flushRef.current(), []);

  const bookmark = id ? getBookmark(id) : undefined;

  // The title shown when not editing. Background metadata enrichment can swap
  // this from the URL/"Untitled" to a long title while the screen stays
  // mounted, so re-measure whenever it changes — otherwise the stale line
  // count leaves an overlong title clamped with no "Show more" toggle.
  const displayedTitle = (bookmark ? displayTitle(bookmark) : null) ?? t('common.untitled');
  useEffect(() => {
    setTitleLineCount(null);
    setTitleExpanded(false);
  }, [displayedTitle]);

  // Forward genuine AI outages (provider error / timeout) to monitoring once per
  // enrichment, so the section can stay quiet in the common case and we still
  // see when the model actually fails. Rate-limits and missing-config are
  // expected fallbacks, not incidents, so they're left out. console.error is the
  // Sentry bridge (observability/sentry.ts); the message carries no content.
  const reportedDegradedRef = useRef<Set<string>>(new Set());
  const reportEnrichment = id ? getEnrichment(id) : undefined;
  useEffect(() => {
    if (!reportEnrichment?.degraded) {
      return;
    }
    const reason = reportEnrichment.degraded_reason;
    if (reason !== 'provider_error' && reason !== 'timeout') {
      return;
    }
    if (reportedDegradedRef.current.has(reportEnrichment.id)) {
      return;
    }
    reportedDegradedRef.current.add(reportEnrichment.id);
    console.error(`[stash] AI enrichment degraded (${reason})`);
  }, [reportEnrichment?.id, reportEnrichment?.degraded, reportEnrichment?.degraded_reason]);

  if (!bookmark) {
    return (
      <View style={styles.missing}>
        <Text style={[styles.missingText, { color: palette.textSecondary }]}>
          {t('detail.notFound')}
        </Text>
      </View>
    );
  }

  // Commit unsaved drafts on unmount (back button) without touching state.
  flushRef.current = () => {
    const dt = draftTitleRef.current;
    const dn = draftNotesRef.current;
    const fields: { title?: string; notes?: string } = {};
    if (dt !== null && dt.trim() !== (bookmark.title ?? '')) {
      fields.title = dt.trim();
    }
    if (dn !== null && dn !== (bookmark.notes ?? '')) {
      fields.notes = dn;
    }
    if (fields.title !== undefined || fields.notes !== undefined) {
      updateBookmarkFields(bookmark.id, fields);
    }
  };

  const tags = getTagsForBookmark(bookmark.id);
  const collection = getCollection(bookmark.collection_id);
  const enrichment = getEnrichment(bookmark.id);
  const canOrganizeRemotely = hasRemoteIdentity(bookmark.id);
  // Any enrichment in flight (auto-trigger or manual) → show the ambient
  // "filling in" skeleton. The manual-only flag drives the explicit button
  // state, so the auto-trigger never makes the section look like a blocking
  // wait the user has to sit through.
  const aiWorking = isEnriching(bookmark.id);
  const aiManual = isManuallyEnriching(bookmark.id);

  // AI suggestions: surface only high-confidence tags not already applied
  // (centralized in @/domain/ai-suggestions) and not dismissed this session,
  // plus a collection that differs from where the bookmark currently lives.
  const appliedTagNames = new Set(tags.map((tag) => tag.name.toLowerCase()));
  // Reviewed = accepted or dismissed in a past session (durable); `dismissed` is
  // this session's not-yet-persisted dismissals (and covers hashtag chips too).
  const reviewedNames = getReviewedSuggestions(bookmark.id);
  const pending = pendingSuggestions(enrichment, appliedTagNames, reviewedNames).filter(
    (suggestion) => !dismissed.has(suggestion.name.toLowerCase()),
  );
  const suggestedCollection = getCollection(enrichment?.suggested_collection_id ?? null);
  const showCollectionSuggestion =
    !!suggestedCollection &&
    bookmark.collection_id !== suggestedCollection.id &&
    suggestedCollection.id !== dismissedCollectionId;

  // Hashtags already written into the captured content (e.g. an Instagram
  // caption's "#목살 #덮밥") make good tags — offer them as one-tap chips, minus
  // any already applied or dismissed, and minus duplicates of an AI suggestion.
  // Only when the bookmark can actually be tagged, so we never surface a chip
  // whose accept would just error.
  const aiSuggestionNames = new Set(pending.map((suggestion) => suggestion.name.toLowerCase()));
  const hashtagTags = canOrganizeRemotely
    ? hashtagSuggestions([bookmark.title, bookmark.description], appliedTagNames).filter(
        (name) =>
          !dismissed.has(name.toLowerCase()) && !aiSuggestionNames.has(name.toLowerCase()),
      )
    : [];

  // AI suggestions carry a real confidence; hashtag chips render the same way
  // but are added straight as user tags when accepted.
  const tagSuggestions = [
    ...pending.map((suggestion) => ({ name: suggestion.name, confidence: suggestion.confidence })),
    ...hashtagTags.map((name) => ({ name, confidence: 1 })),
  ];

  const notesValue = draftNotes ?? bookmark.notes ?? '';

  // Auto-save on blur: edit in place, no explicit "Save" button.
  const commitTitle = () => {
    if (draftTitle !== null && draftTitle.trim() !== (bookmark.title ?? '')) {
      updateBookmarkFields(bookmark.id, { title: draftTitle.trim() });
      // The displayedTitle effect re-measures once the store update lands.
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
    bookmark.url ? { label: t('detail.rowUrl'), value: bookmark.url } : null,
    bookmark.site_name ? { label: t('detail.rowSite'), value: bookmark.site_name } : null,
    // Skip the Description row for a text note whose body is already the header
    // title, so the same text doesn't appear twice.
    bookmark.description && bookmark.description !== displayedTitle
      ? { label: t('detail.rowDescription'), value: bookmark.description }
      : null,
    { label: t('detail.rowSaved'), value: formatDate(bookmark.created_at) },
    bookmark.source_app ? { label: t('detail.rowFrom'), value: bookmark.source_app } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  // Sync/metadata are de-emphasized: only surfaced as small chips when they
  // are noteworthy (not yet synced / still enriching), never as full cards.
  const statusChips: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    statusChips.push(syncStatusLabel(t, bookmark.sync_status));
  }
  if (bookmark.metadata_status !== 'complete') {
    statusChips.push(metadataStatusLabel(t, bookmark.metadata_status));
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
      setOrganizeError(t('detail.errorShare'));
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
    } else {
      // A hashtag chip — accepting it adds a plain user tag.
      void runOrganizeAction(() => addTagsToBookmark(bookmark.id, [name]));
    }
  };
  const handleDismissTag = (name: string) => {
    setDismissed((prev) => new Set(prev).add(name.toLowerCase()));
    // Dismissing an AI suggestion is a review decision — persist it so the "✨"
    // badge stays gone across sessions. Hashtag chips aren't AI suggestions, so
    // they only get the session-local dismissal above.
    if (aiSuggestionNames.has(name.toLowerCase())) {
      markSuggestionsReviewed(bookmark.id, [name]);
    }
  };
  // One-tap "yes to all" mirror of dismiss-all: apply every chip at once. AI
  // suggestions go through acceptSuggestedTags (records the accept review);
  // hashtag chips become plain user tags.
  const handleAcceptAll = () => {
    const hashtagNames = tagSuggestions
      .filter((suggestion) => !aiSuggestionNames.has(suggestion.name.toLowerCase()))
      .map((suggestion) => suggestion.name);
    void runOrganizeAction(async () => {
      if (pending.length > 0) {
        const error = await acceptSuggestedTags(bookmark.id, pending);
        if (error) {
          return error;
        }
      }
      if (hashtagNames.length > 0) {
        return addTagsToBookmark(bookmark.id, hashtagNames);
      }
      return null;
    });
  };
  // One-tap "no thanks" for the whole row: session-dismiss every chip, and
  // persist the AI ones as reviewed (same rule as a single dismiss).
  const handleDismissAll = () => {
    const names = tagSuggestions.map((suggestion) => suggestion.name);
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const name of names) {
        next.add(name.toLowerCase());
      }
      return next;
    });
    const aiNames = names.filter((name) => aiSuggestionNames.has(name.toLowerCase()));
    if (aiNames.length > 0) {
      markSuggestionsReviewed(bookmark.id, aiNames);
    }
  };

  // A manual re-run is a deliberate "reconsider": forget prior dismissals so the
  // model can surface tags it still recommends (accepted tags stay applied).
  const handleSuggestAi = () => {
    clearReviewedSuggestions(bookmark.id);
    void runOrganizeAction(async () => {
      const error = await requestAiEnrichment(bookmark.id);
      // The store is i18n-free and signals rate-limiting with a sentinel; localize
      // it here so the message respects the user's locale.
      return error === AI_RATE_LIMITED ? t('detail.aiRateLimited') : error;
    });
  };

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
      return result.error ?? t('detail.errorCreateCollection');
    });

  const handleOpenLink = () => {
    if (bookmark.url) {
      void Linking.openURL(bookmark.url).catch(() => {
        setOrganizeError(t('detail.errorOpen'));
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
      if (typeof confirm === 'undefined' || confirm(t('detail.deleteConfirmWeb'))) {
        remove();
      }
      return;
    }
    Alert.alert(t('bookmark.deleteTitle'), t('bookmark.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: remove },
    ]);
  };

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 32 }]}
    >
      {bookmark.preview_image_url ? (
        bookmark.url ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('common.openLink')}
            onPress={handleOpenLink}
          >
            <Image
              source={{ uri: bookmark.preview_image_url }}
              style={styles.preview}
              resizeMode="cover"
            />
          </Pressable>
        ) : (
          <Image
            source={{ uri: bookmark.preview_image_url }}
            style={styles.preview}
            resizeMode="cover"
          />
        )
      ) : null}
      {/* Compact byline: favicon · host · status, instead of a header card. */}
      <View style={styles.byline}>
        {bookmark.favicon_url ? (
          <View style={[styles.bylineFavTile, { borderColor: palette.border }]}>
            <Image source={{ uri: bookmark.favicon_url }} style={styles.bylineFav} resizeMode="contain" />
          </View>
        ) : null}
        <Text style={[styles.bylineText, { color: palette.textSecondary }]} numberOfLines={1}>
          {host ?? t('detail.savedByline')}
          {statusChips.length > 0 ? `  ·  ${statusChips.join(' · ')}` : ''}
        </Text>
      </View>

      {/* Title — tap to edit in place, auto-saved on blur. Overlong titles
          (full social captions) collapse to a few lines with a Show more
          toggle so they don't crowd out the rest of the screen. */}
      {draftTitle === null ? (
        <View
          style={styles.titleBlock}
          // A width change (e.g. rotation) can change how the title wraps, so
          // re-measure to keep the overflow/"Show more" state accurate.
          onLayout={(event) => {
            const width = event.nativeEvent.layout.width;
            if (titleWidth !== null && width !== titleWidth) {
              setTitleLineCount(null);
            }
            setTitleWidth(width);
          }}
        >
          <Pressable
            accessibilityRole="button"
            // Announce the title itself (not just the action) so screen-reader
            // users still hear the primary content; the edit affordance is a hint.
            accessibilityLabel={displayedTitle}
            accessibilityHint={t('detail.editTitleHint')}
            onPress={() => setDraftTitle(bookmark.title ?? '')}
          >
            <Text
              style={[styles.title, { color: palette.text }]}
              // Measure unclamped on first layout so overflow detection is
              // reliable across platforms; clamp once we know the line count.
              numberOfLines={
                titleLineCount === null || titleExpanded ? undefined : TITLE_COLLAPSED_LINES
              }
              onTextLayout={(event) => {
                if (titleLineCount === null) {
                  setTitleLineCount(event.nativeEvent.lines.length);
                }
              }}
            >
              {displayedTitle}
            </Text>
          </Pressable>
          {titleLineCount !== null && titleLineCount > TITLE_COLLAPSED_LINES ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={titleExpanded ? t('detail.showLessTitleA11y') : t('detail.showFullTitleA11y')}
              hitSlop={8}
              onPress={() => setTitleExpanded((value) => !value)}
            >
              <Text style={[styles.titleToggle, { color: palette.accent }]}>
                {titleExpanded ? t('detail.showLess') : t('detail.showMore')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={t('detail.editTitleA11y')}
          autoFocus
          multiline
          style={[styles.title, styles.titleInput, { color: palette.text, borderColor: palette.border }]}
          placeholder={t('detail.titlePlaceholder')}
          placeholderTextColor={palette.textSecondary}
          value={draftTitle}
          onChangeText={setDraftTitle}
          onBlur={commitTitle}
        />
      )}

      <View style={styles.actionBar}>
        {bookmark.url ? (
          <ActionButton icon="open-outline" label={t('common.open')} tint={palette.accent} onPress={handleOpenLink} />
        ) : null}
        {bookmark.url ? (
          <ActionButton icon="share-social" label={t('common.share')} tint={palette.text} onPress={handleShare} />
        ) : null}
        <ActionButton
          icon={bookmark.is_archived ? 'arrow-undo' : 'archive'}
          label={bookmark.is_archived ? t('common.unarchive') : t('common.archive')}
          tint={palette.text}
          onPress={() => archiveBookmark(bookmark.id, !bookmark.is_archived)}
        />
        <ActionButton icon="trash" label={t('common.delete')} tint={palette.danger} onPress={handleDelete} />
      </View>

      {/* Notes — a pencil affordance + filled field so it reads as editable
          (an unlabeled box alone looked like a divider on the dark theme). */}
      <View
        style={[
          styles.notesBox,
          { backgroundColor: palette.surfaceElevated, borderColor: palette.border },
        ]}
      >
        <Ionicons
          name="create-outline"
          size={16}
          color={palette.textSecondary}
          style={styles.notesIcon}
        />
        <TextInput
          accessibilityLabel={t('detail.notesA11y')}
          style={[styles.notesInput, { color: palette.text }]}
          placeholder={t('detail.notesPlaceholder')}
          placeholderTextColor={palette.textSecondary}
          multiline
          value={notesValue}
          onChangeText={setDraftNotes}
          onBlur={commitNotes}
        />
      </View>

      {/* Collection — no title; the folder-icon picker speaks for itself.
          It leads the organize controls, directly above the tag field. */}
      <View style={styles.collectionBlock}>
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
            {t('detail.currentlyIn', { name: collection.name })}
          </Text>
        ) : null}
        {/* Suggested folder lives next to the picker as a one-tap chip, the same
            shape as a suggested tag: tap to file in, ✕ to dismiss. */}
        {showCollectionSuggestion ? (
          <View style={styles.suggestionRow}>
            <View style={[styles.ghostChip, { borderColor: palette.accent }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('detail.aiFileIntoA11y', { name: suggestedCollection!.name })}
                disabled={busy}
                onPress={handleAcceptCollection}
              >
                <Text style={[styles.ghostLabel, { color: palette.accent }]}>
                  {t('detail.aiSuggestCollectionChip', { name: suggestedCollection!.name })}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('detail.aiDismissCollectionA11y', {
                  name: suggestedCollection!.name,
                })}
                disabled={busy}
                hitSlop={6}
                onPress={() => setDismissedCollectionId(suggestedCollection!.id)}
              >
                <Text style={[styles.ghostRemove, { color: palette.textSecondary }]}>✕</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      {/* Tags sit under the folder as a compact token field (its own
          "Add tags…" placeholder labels it), not a separate titled panel. */}
      <TagField
        tags={tags.map((tag) => ({ id: tag.id, name: tag.name }))}
        suggestions={tagSuggestions}
        editable={canOrganizeRemotely}
        busy={busy}
        onAdd={handleAddTag}
        onRemove={handleRemoveTag}
        onBrowse={(tagId) => router.navigate({ pathname: '/', params: { tag: tagId } })}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={handleDismissTag}
        onAcceptAllSuggestions={handleAcceptAll}
        onDismissAllSuggestions={handleDismissAll}
        disabledHint={
          canOrganizeRemotely ? undefined : t('detail.tagsDisabledHint')
        }
      />

      {/* AI suggestions — no redundant header; the action button names itself. */}
      <Card elevated={false} style={styles.field}>
        {aiWorking ? (
          // Ambient placeholder: suggestions are filling in. Deliberately not a
          // centered spinner + "working…" label, which reads as a modal wait —
          // the screen stays fully interactive while this pulses.
          <SuggestionSkeleton style={styles.suggestHeader} />
        ) : enrichment?.model ? (
          <View style={styles.suggestHeader}>
            <View style={[styles.aiBadge, { borderColor: palette.border }]}>
              <Text style={[styles.aiBadgeLabel, { color: palette.textSecondary }]}>
                {enrichment.model}
              </Text>
            </View>
          </View>
        ) : null}

        {enrichment?.status === 'stale' ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>{t('detail.aiStale')}</Text>
        ) : null}

        {enrichment?.degraded && !aiWorking ? (
          <Text
            accessibilityRole="text"
            style={[styles.hint, { color: palette.textSecondary }]}
          >
            {enrichmentDegradedLabel(t, enrichment.degraded_reason)}
          </Text>
        ) : null}

        {enrichment?.summary ? (
          <Text style={[styles.fieldValue, { color: palette.text }]}>{enrichment.summary}</Text>
        ) : null}

        {canOrganizeRemotely ? (
          <Pressable
            accessibilityRole="button"
            // Gate only on a manual request — an auto-trigger must leave the
            // control live so the section never feels like it's blocking.
            accessibilityState={{ disabled: busy || aiManual, busy: aiManual }}
            disabled={busy || aiManual}
            style={[styles.suggestButton, { borderColor: palette.border }]}
            onPress={() => void handleSuggestAi()}
          >
            <Text style={[styles.actionLabel, { color: palette.accent }]}>
              {aiManual
                ? t('detail.aiGenerating')
                : enrichment
                  ? t('detail.aiRefresh')
                  : t('detail.aiSuggest')}
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>{t('detail.aiNeedsSync')}</Text>
        )}
      </Card>

      <View style={styles.detailsSection}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('detail.toggleDetailsA11y')}
          onPress={() => setShowDetails((value) => !value)}
          style={styles.detailsToggle}
        >
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
            {showDetails ? t('detail.detailsHide') : t('detail.detailsShow')}
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
  titleBlock: {
    gap: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  titleToggle: {
    fontSize: 14,
    fontWeight: '600',
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
  collectionBlock: {
    gap: 6,
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
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ghostChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderStyle: 'dashed',
  },
  ghostLabel: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    includeFontPadding: false,
  },
  ghostRemove: {
    fontSize: 12,
    fontWeight: '700',
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
  notesBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 64,
  },
  notesIcon: {
    marginTop: 3,
  },
  notesInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    minHeight: 40,
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
