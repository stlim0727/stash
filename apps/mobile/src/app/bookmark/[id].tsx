import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
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
import { PostHogMaskView } from 'posthog-react-native';

import { useI18n } from '@/i18n';
import { hasRepeatedDnsFailures } from '@/domain/network-errors';
import {
  enrichmentDegradedLabel,
  metadataStatusLabel,
  syncStatusLabel,
  videoUnavailableLabel,
} from '@/i18n/status';
import { usePalette } from '@/theme';
import { Card } from '@/ui/Card';
import { CollectionPicker } from '@/ui/CollectionPicker';
import { KeyboardAvoidingScreen } from '@/ui/KeyboardAvoidingScreen';
import { MarkdownBody } from '@/ui/MarkdownBody';
import { SuggestionSkeleton } from '@/ui/SuggestionSkeleton';
import { TagField } from '@/ui/TagField';
import { useCaptureToast } from '@/ui/capture-toast';
import { nextFacetNonce } from '@/domain/facet-nonce';
import { hostFromUrl } from '@/domain/item-icon';
import { displayTitle, isTitleDerived } from '@/domain/item-display';
import {
  isTitleRestatement,
  pendingSuggestions,
  suggestedFolderTokens,
  summaryToken,
} from '@/domain/ai-suggestions';
import type { SuggestedFolder } from '@/domain/ai-suggestions';
import { FolderSuggestionLabel, folderChipA11yLabel } from '@/ui/folder-suggestion-chip';
import { ProposedSummary } from '@/ui/ProposedSummary';
import { collectionMatchKey } from '@/domain/collection-match';
import { hashtagSuggestions } from '@/domain/hashtags';
import { AI_RATE_LIMITED, useBookmarks } from '@/store/bookmarks';
import { trackBreadcrumb } from '@/observability/sentry';
import {
  acceptSuggestionBundle,
  dismissSuggestionBundle,
  recordFolderSuggestionActedOn,
} from '@/domain/suggestion-actions';
import { hasRemoteIdentity, isLocalOnlyBookmark } from '@/sync/sync-bookmarks';

// Lines of title shown before collapsing behind a "Show more" toggle.
const TITLE_COLLAPSED_LINES = 4;
const MAX_MEMO_LENGTH = 10_000;

interface BookmarkDetailScreenProps {
  inlineId?: string;
  onInlineClose?: () => void;
  markAccessOnMount?: boolean;
  hidePreviewHero?: boolean;
}

export default function BookmarkDetailScreen({
  inlineId,
  onInlineClose,
  markAccessOnMount = true,
  hidePreviewHero = false,
}: BookmarkDetailScreenProps = {}) {
  const palette = usePalette();
  const { t, formatDate } = useI18n();
  const router = useRouter();
  const { show: showToast } = useCaptureToast();
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const {
    getBookmark,
    queue,
    getTagsForBookmark,
    getCollection,
    getEnrichment,
    trashBookmark,
    restoreBookmark,
    updateBookmarkFields,
    markBookmarkAccessed,
    checkVideoAvailability,
    deleteBookmark,
    collections,
    addTagsToBookmark,
    removeTagFromBookmark,
    requestAiEnrichment,
    refreshBookmarkPreview,
    isRefreshingPreview,
    isEnriching,
    isManuallyEnriching,
    isAiSuggestionPostponed,
    isAiSuggestionServerQueued,
    hadPriorEnrichmentAttempt,
    acceptSuggestedTags,
    getReviewedSuggestions,
    markSuggestionsReviewed,
    clearReviewedSuggestions,
    getDismissedFolderSuggestions,
    dismissFolderSuggestion,
    clearDismissedFolderSuggestions,
    getReviewedSummary,
    markSummaryReviewed,
    clearReviewedSummary,
    markSuggestionsSeen,
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
  const [draftDescription, setDraftDescription] = useState<string | null>(null);
  const [memoEditing, setMemoEditing] = useState(false);
  const [notesFocused, setNotesFocused] = useState(false);
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
  const draftDescriptionRef = useRef<string | null>(null);
  draftTitleRef.current = draftTitle;
  draftNotesRef.current = draftNotes;
  draftDescriptionRef.current = draftDescription;
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => () => flushRef.current(), []);

  // Cleanup on unmount (STASH-1H): clear any error state so a stale "notes too
  // long" red border or organizeError does not re-appear on next visit.
  useEffect(() => {
    return () => {
      setOrganizeError(null);
    };
  }, []);

  // On web a multiline TextInput renders as a fixed-height <textarea> that
  // scrolls instead of growing (native auto-grows on its own). Size the notes
  // field to its content on every render so the whole memo is visible without an
  // inner scrollbar. No-op on native, where the field already grows.
  const notesRef = useRef<TextInput | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const node = notesRef.current as unknown as HTMLTextAreaElement | null;
    if (!node || !('style' in node)) {
      return;
    }
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  });

  const id = inlineId ?? routeId;
  const inline = inlineId !== undefined;
  const bookmark = id ? getBookmark(id) : undefined;
  const isTextMemo = bookmark?.content_type === 'text' && !bookmark.url;
  const syncQueueEntry = bookmark
    ? queue.find((entry) => entry.local_id === bookmark.id)
    : undefined;
  const repeatedDnsFailure = hasRepeatedDnsFailures(queue);

  // The title shown when not editing. Background metadata enrichment can swap
  // this from the URL/"Untitled" to a long title while the screen stays
  // mounted, so re-measure whenever it changes — otherwise the stale line
  // count leaves an overlong title clamped with no "Show more" toggle.
  const displayedTitle = bookmark
    ? isTextMemo
      ? bookmark.title?.trim() || t('detail.memoFallbackTitle')
      : displayTitle(bookmark) ?? t('common.untitled')
    : t('common.untitled');
  useEffect(() => {
    setTitleLineCount(null);
    setTitleExpanded(false);
  }, [displayedTitle]);

  // Leave a monitoring trail for genuine AI outages (provider error / timeout)
  // once per enrichment, so we can still see when the model actually fails.
  // Rate-limits and missing-config are expected fallbacks, not incidents, so
  // they're left out. This is a low-severity *breadcrumb*, not console.error:
  // a degraded fallback is a handled, in-app-surfaced condition (the "basic
  // suggestions" note below), so it must not raise a standalone Sentry error
  // issue — it just attaches to any real event from this session. The message
  // carries no content.
  // Opening a bookmark's Detail means the user is now witnessing its AI
  // suggestions, so clear the Inbox "new suggestions" flag for it. Keyed on the
  // enrichment too, so a suggestion that lands *while* this screen is open
  // (a background auto-enrichment finishing) is dismissed immediately rather
  // than re-announcing it on the Inbox.
  const reportedDegradedRef = useRef<Set<string>>(new Set());
  // Key witness/access tracking off the *resolved* bookmark id, not the raw
  // route param: a freshly-shared bookmark adopts its remote id when its create
  // syncs while this screen is open, so the route's local id would otherwise
  // point at a row that no longer exists.
  const resolvedId = bookmark?.id;
  const reportEnrichment = resolvedId ? getEnrichment(resolvedId) : undefined;
  useEffect(() => {
    if (resolvedId) {
      markSuggestionsSeen(resolvedId);
    }
  }, [resolvedId, reportEnrichment, markSuggestionsSeen]);
  // Viewing a bookmark's Detail counts as opening it — record the access so the
  // "Recently opened" Inbox sort reflects it. Once per id (a re-open remounts).
  useEffect(() => {
    if (markAccessOnMount && resolvedId) {
      markBookmarkAccessed(resolvedId);
    }
  }, [markAccessOnMount, resolvedId, markBookmarkAccessed]);
  // STASH-61: opening Detail is also the one on-demand moment we check whether
  // a saved YouTube video is still available — never background polling. The
  // store no-ops for a non-YouTube bookmark, so this is safe to call for every
  // bookmark opened. Once per id (a re-open remounts), mirroring the access
  // tracking above.
  useEffect(() => {
    if (resolvedId) {
      checkVideoAvailability(resolvedId, bookmark?.url);
    }
  }, [resolvedId, bookmark?.url, checkVideoAvailability]);
  // One breadcrumb on first mount so a freeze right after opening a
  // freshly-shared bookmark (Sentry STASH-H) places the Detail screen on the
  // event timeline. Coarse only: whether the row resolved from local state — a
  // resolved row that still froze points at the tail/render, not data-loading.
  const mountReportedRef = useRef(false);
  useEffect(() => {
    if (mountReportedRef.current) {
      return;
    }
    mountReportedRef.current = true;
    trackBreadcrumb('detail', 'mounted', { resolved: bookmark !== undefined });
  }, [bookmark]);
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
    trackBreadcrumb('enrichment', 'degraded', { reason });
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
    const dd = draftDescriptionRef.current;
    const fields: { title?: string; notes?: string; description?: string } = {};
    if (dt !== null && dt.trim() !== (bookmark.title ?? '')) {
      fields.title = dt.trim();
    }
    if (dn !== null && dn !== (bookmark.notes ?? '')) {
      fields.notes = dn;
    }
    // Compare the raw draft against the raw stored description — see the
    // same fix in commitDescription below.
    if (dd !== null && dd !== (bookmark.description ?? '')) {
      fields.description = dd;
    }
    if (
      fields.title !== undefined ||
      fields.notes !== undefined ||
      fields.description !== undefined
    ) {
      updateBookmarkFields(bookmark.id, fields);
    }
  };

  const tags = getTagsForBookmark(bookmark.id);
  const collection = getCollection(bookmark.collection_id);
  const enrichment = getEnrichment(bookmark.id);
  // hasRemoteIdentity excludes seed/sample rows, and isLocalOnlyBookmark
  // excludes local-only rows (e.g. a not-yet-uploaded image bookmark) — both
  // are marked sync_status: 'synced' locally too even though they were never
  // a real cloud row (see hasSyncedOnce in store/bookmarks.tsx).
  const canOrganizeRemotely =
    hasRemoteIdentity(bookmark.id) &&
    (bookmark.sync_status === 'synced' || bookmark.ever_synced === true) &&
    !isLocalOnlyBookmark(bookmark);
  // Any enrichment in flight (auto-trigger or manual) → show the ambient
  // "filling in" skeleton. The manual-only flag drives the explicit button
  // state, so the auto-trigger never makes the section look like a blocking
  // wait the user has to sit through.
  const aiWorking = isEnriching(bookmark.id);
  const aiManual = isManuallyEnriching(bookmark.id);
  // True only while waiting out backoff (goes false the instant a retry
  // starts) — drives the calm "still working on it" note.
  const aiPostponed = isAiSuggestionPostponed(bookmark.id);
  // True once the 429 that armed aiPostponed above was CONFIRMED accepted
  // into the server-side overflow queue — a stronger, self-resolving promise
  // than the generic "postponed" note. armAiRetry fires unconditionally on
  // EVERY failure (this 429 included), so both flags are true at once for a
  // rate-limited bookmark; this one takes priority below.
  const aiServerQueued = isAiSuggestionServerQueued(bookmark.id);
  const previewRefreshing = isRefreshingPreview(bookmark.id);

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
  // The AI proposes a collection by name. The edge function resolves it to an
  // existing collection id when one fits (tolerant of case/spacing); when none
  // did, it passes the raw name through so we can offer to *create* it. We also
  // re-check that name against the live collection list here, so a collection
  // the user made since the enrichment ran is offered as "file in" rather than a
  // duplicate "create".
  const suggestedByName = enrichment?.suggested_collection_name?.trim() || null;
  // Re-match against the live collection list with the SAME tolerant key the
  // edge function used, so a folder the user created since the enrichment ran
  // (e.g. "watch-later") still resolves a suggestion of "Watch Later" to "file
  // into" rather than offering a duplicate "create".
  const suggestedNameKey = suggestedByName ? collectionMatchKey(suggestedByName) : '';
  const localNameMatch = suggestedNameKey
    ? collections.find((item) => collectionMatchKey(item.name) === suggestedNameKey)
    : undefined;
  const suggestedCollection =
    getCollection(enrichment?.suggested_collection_id ?? null) ?? localNameMatch ?? null;
  // Folder dismissals are durable (per bookmark, keyed by stable tokens) so a
  // dismissed chip stays gone when the user re-enters Detail — a later enrichment
  // proposing a *different* folder yields a different token and re-surfaces.
  //
  // The SAME recommendation can render as either a "create {name}" chip or a
  // "file into {existing}" chip depending on whether a matching collection exists
  // yet — and that can flip after the user dismisses it (a folder named like the
  // suggestion gets created or pulled later, or an existing one is deleted). So a
  // suggestion is identified by BOTH its resolved-collection id and the AI's
  // proposed-name key; a dismissal recorded under either token suppresses both
  // forms, and dismissing records every applicable token.
  const dismissedFolderTokens = getDismissedFolderSuggestions(bookmark.id);
  // The collection the bookmark sits in now (when known) — attached as `from` so
  // the chip reads as a *move* (📁 ~~from~~ → target) rather than a plain add
  // when the bookmark already lives somewhere else. Unknown current collection →
  // no `from` (render as an add), matching resolveSuggestedFolder's rule.
  const currentFrom =
    collection && bookmark.collection_id
      ? { id: bookmark.collection_id, name: collection.name }
      : null;
  const suggestedFolder: SuggestedFolder | null = suggestedCollection
    ? {
        kind: 'existing',
        id: suggestedCollection.id,
        name: suggestedCollection.name,
        from: currentFrom,
      }
    : suggestedByName
      ? { kind: 'create', name: suggestedByName, from: currentFrom }
      : null;
  const folderTokens = suggestedFolderTokens(suggestedFolder, suggestedByName);
  const folderSuggestionDismissed = folderTokens.some((token) => dismissedFolderTokens.has(token));
  const showCollectionSuggestion =
    !!suggestedCollection &&
    bookmark.collection_id !== suggestedCollection.id &&
    !folderSuggestionDismissed;
  // Offer to create a brand-new collection only when nothing existing matched.
  const showCreateCollectionSuggestion =
    !suggestedCollection && !!suggestedByName && !folderSuggestionDismissed;
  // A folder chip (file-into or create) is currently on screen — so the tag
  // field's "Add all"/"Dismiss all" should sweep it too, like the Review screen.
  const isPreviewFailed = bookmark.metadata_status === 'failed';

  const folderSuggestionVisible = !isPreviewFailed && (showCollectionSuggestion || showCreateCollectionSuggestion);

  // Hashtags already written into the captured content (e.g. an Instagram
  // caption's "#목살 #덮밥") make good tags — offer them as one-tap chips, minus
  // any already applied or dismissed, and minus duplicates of an AI suggestion.
  // Only when the bookmark can actually be tagged, so we never surface a chip
  // whose accept would just error.
  const aiSuggestionNames = new Set(pending.map((suggestion) => suggestion.name.toLowerCase()));
  const hashtagTags = canOrganizeRemotely && !isPreviewFailed
    ? hashtagSuggestions([bookmark.title, bookmark.description], appliedTagNames).filter(
        (name) =>
          !dismissed.has(name.toLowerCase()) && !aiSuggestionNames.has(name.toLowerCase()),
      )
    : [];

  // AI suggestions carry a real confidence; hashtag chips render the same way
  // but are added straight as user tags when accepted.
  const tagSuggestions = isPreviewFailed
    ? []
    : [
        ...pending.map((suggestion) => ({ name: suggestion.name, confidence: suggestion.confidence })),
        ...hashtagTags.map((name) => ({ name, confidence: 1 })),
      ];

  // AI card visibility. The dummy-v0 heuristic fallback (see
  // supabase/functions/ai-enrich/dummy-provider.ts) still emits a generic
  // "Url from {host} — … Auto-categorized by dummy-v0." summary and a degraded
  // note even when it produced nothing to act on — three lines of ceremony over
  // an empty result. Collapse the card to just its affordance in that case:
  //  - `hasActionableSuggestions` mirrors the Inbox "✨ N" badge rule exactly
  //    (pending AI tags OR a live folder chip — the same filtered lists, never
  //    the raw enrichment), so a card the Inbox refuses to badge never shouts
  //    here either.
  //  - a summary counts as real content only from a real model; the dummy-v0
  //    boilerplate ("Url from {host} — … Auto-categorized by dummy-v0[; review
  //    the suggested tags below]") is noise *regardless* of what else is on the
  //    card — surfacing it as a proposed note next to real tag suggestions just
  //    leaks the internal model name and points at "tags below" that live in a
  //    separate widget. Keying on the model (not the persisted `degraded` flag)
  //    also silences older dummy rows that were never marked degraded, and it
  //    survives re-sync without a backfill.
  const hasActionableSuggestions = pending.length > 0 || folderSuggestionVisible;
  // The summary is offered as a proposed note (see ProposedSummary below). A
  // stable token derived from the summary text lets "use as note" / dismiss
  // persist durably: an identical re-pull stays quiet, a genuinely new summary
  // from a later enrichment yields a new token and re-surfaces.
  const summaryTok = summaryToken(enrichment?.summary);
  const summaryReviewed = summaryTok !== null && getReviewedSummary(bookmark.id).has(summaryTok);
  // STASH-31 ("AI-suggested memos are all useless"): with no fetched page
  // description to draw from, the model's only real input is usually the
  // title, so a low-effort summary just restates it back. Suppress that case
  // here too (see isTitleRestatement in @/domain/ai-suggestions) so Detail
  // agrees with pendingSummary's rule for Review/Inbox.
  const summaryText = enrichment?.summary?.trim() ?? '';
  const showAiSummary =
    !isPreviewFailed &&
    Boolean(summaryText) &&
    !summaryReviewed &&
    enrichment?.model !== 'dummy-v0' &&
    !isTitleRestatement(summaryText, bookmark.title ?? '');
  const showAiReport = hasActionableSuggestions || showAiSummary;
  // The screen-level "Dismiss all suggestions" (in the AI control strip) only
  // earns its place once suggestions are spread across 2+ widgets — folder,
  // tags, summary — since no single widget can own the sweep then. With one
  // surface live, that widget's own dismiss is enough.
  const activeSuggestionSurfaces =
    (folderSuggestionVisible ? 1 : 0) +
    (tagSuggestions.length > 0 ? 1 : 0) +
    (showAiSummary ? 1 : 0);
  const showDismissAllSuggestions = activeSuggestionSurfaces > 1;
  // The degraded note explains *thin* results — keep it only when there is
  // something to explain, or when the cause is one the user can act on (a
  // transient rate limit). A generic "Couldn't reach AI" over an otherwise
  // empty card is exactly the noise to silence; the outage still reaches
  // monitoring via the breadcrumb reported above.
  const showDegradedNote =
    !!enrichment?.degraded &&
    !aiWorking &&
    (showAiReport || enrichment.degraded_reason === 'rate_limited');

  const notesValue = draftNotes ?? bookmark.notes ?? '';
  const memoValue = draftDescription ?? bookmark.description ?? '';
  const notesLength = notesValue.length;
  // 10k chars is generous ( ~2 printed pages) while preventing UI breakage or
  // sync bloat. Matches the truncation warning shown below.
  const MAX_NOTES_LENGTH = 10000;
  const notesTooLong = notesLength > MAX_NOTES_LENGTH;

  // Show the contained (bordered/elevated) treatment only when there's a note to
  // hold or the user is editing; otherwise render a light borderless prompt.
  const notesFilled = notesValue.trim() !== '' || notesFocused;

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
      // Truncate on save for STASH-1J (prevents DB bloat / sync issues on very
      // long input). The UI warning already nudges the user; this is a safety.
      const safeNotes = draftNotes.length > MAX_NOTES_LENGTH
        ? draftNotes.slice(0, MAX_NOTES_LENGTH)
        : draftNotes;
      updateBookmarkFields(bookmark.id, { notes: safeNotes });
    }
    setDraftNotes(null);
  };
  const commitDescription = () => {
    // Compare the raw draft against the raw stored description — trimming
    // either side here would make merely entering and leaving Edit report a
    // change for a memo with meaningful leading/trailing whitespace (e.g. an
    // indented code block), enqueuing a no-op sync.
    if (draftDescription !== null && draftDescription !== (bookmark.description ?? '')) {
      updateBookmarkFields(bookmark.id, {
        // Existing captures/backups can predate the editor's creation cap.
        // Never truncate that user-authored source merely because it was edited.
        description: draftDescription,
      });
    }
    setDraftDescription(null);
  };

  // One tidy "Details" section instead of a card per field. Only rows with a
  // real value show, so a sparse bookmark doesn't render mostly-empty cards.
  const details = [
    bookmark.url ? { label: t('detail.rowUrl'), value: bookmark.url } : null,
    bookmark.site_name ? { label: t('detail.rowSite'), value: bookmark.site_name } : null,
    // Skip the Description row for a text note whose body is already the header
    // title, so the same text doesn't appear twice.
    !isTextMemo && bookmark.description && bookmark.description !== displayedTitle
      ? { label: t('detail.rowDescription'), value: bookmark.description }
      : null,
    { label: t('detail.rowSaved'), value: formatDate(bookmark.created_at) },
    bookmark.source_app ? { label: t('detail.rowFrom'), value: bookmark.source_app } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  // Sync/metadata are de-emphasized: only surfaced as small chips when they
  // are noteworthy (not yet synced / still enriching), never as full cards.
  const statusChips: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    statusChips.push(syncStatusLabel(t, bookmark.sync_status, syncQueueEntry, repeatedDnsFailure));
  }
  if (bookmark.metadata_status !== 'complete') {
    statusChips.push(metadataStatusLabel(t, bookmark.metadata_status));
  }
  if (bookmark.video_unavailable) {
    statusChips.push(videoUnavailableLabel(t));
  }

  const host = hostFromUrl(bookmark.url);

  const handleShare = () => {
    const message = bookmark.url ?? (isTextMemo ? memoValue : null);
    if (!message) {
      return;
    }
    void Share.share(
      bookmark.url
        ? { message, url: bookmark.url, title: bookmark.title ?? undefined }
        : { message, title: bookmark.title ?? undefined },
    ).catch(() => {
      setOrganizeError(t('detail.errorShare'));
    });
  };

  const handleCopyLink = () => {
    const value = bookmark.url ?? (isTextMemo ? memoValue : null);
    if (!value) {
      return;
    }
    void Clipboard.setStringAsync(value)
      .then(() => {
        showToast(t(isTextMemo ? 'toast.memoCopied' : 'toast.linkCopied'));
      })
      .catch(() => {
        setOrganizeError(t('detail.errorCopyLink'));
      });
  };

  const handleRefreshPreview = () => {
    void runOrganizeAction(async () => {
      const error = await refreshBookmarkPreview(bookmark.id);
      return error ? t('detail.errorRefreshPreview') : null;
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

  const suggestionActionDeps = {
    acceptSuggestedTags,
    addTagsToBookmark,
    assignCollection,
    createCollection,
    dismissFolderSuggestion,
  };

  const handleAddTag = (name: string) =>
    runOrganizeAction(() => addTagsToBookmark(bookmark.id, [name]));
  const handleRemoveTag = (name: string) =>
    void runOrganizeAction(() => removeTagFromBookmark(bookmark.id, name));
  const handleAcceptSuggestion = (name: string) => {
    const match = pending.find((suggestion) => suggestion.name === name);
    void runOrganizeAction(() =>
      acceptSuggestionBundle(suggestionActionDeps, {
        bookmarkId: bookmark.id,
        aiSuggestions: match ? [match] : [],
        // A hashtag chip — accepting it adds a plain user tag.
        plainTagNames: match ? [] : [name],
        folder: null,
        folderTokens: [],
        createCollectionError: t('detail.errorCreateCollection'),
      }),
    );
  };
  const handleDismissTag = (name: string) => {
    setDismissed((prev) => new Set(prev).add(name.toLowerCase()));
    // Dismissing an AI suggestion is a review decision — persist it so the "✨"
    // badge stays gone across sessions. Hashtag chips aren't AI suggestions, so
    // they only get the session-local dismissal above.
    if (aiSuggestionNames.has(name.toLowerCase())) {
      dismissSuggestionBundle({
        bookmarkId: bookmark.id,
        aiSuggestionNames: [name],
        folderTokens: [],
        markSuggestionsReviewed,
        dismissFolderSuggestion,
      });
    }
  };
  // One-tap "yes to all" for the tag row: apply every tag chip at once. AI tags
  // go through acceptSuggestedTags (records the accept review); hashtag chips
  // become plain user tags. The folder now lives under the picker with its own
  // ✓, and the summary is a deliberate note action, so neither is swept here —
  // "Add all" means the tags, unambiguously.
  const handleAcceptAll = () => {
    const hashtagNames = tagSuggestions
      .filter((suggestion) => !aiSuggestionNames.has(suggestion.name.toLowerCase()))
      .map((suggestion) => suggestion.name);
    void runOrganizeAction(async () => {
      return acceptSuggestionBundle(suggestionActionDeps, {
        bookmarkId: bookmark.id,
        aiSuggestions: pending,
        plainTagNames: hashtagNames,
        folder: null,
        folderTokens: [],
        createCollectionError: t('detail.errorCreateCollection'),
      });
    });
  };
  // Tags-only "no thanks": session-dismiss every tag chip and persist the AI
  // ones as reviewed (same rule as a single dismiss). Passed to TagField, so it
  // sweeps only the tag row — the folder and summary each own their own dismiss.
  const handleDismissAllTags = () => {
    const names = tagSuggestions.map((suggestion) => suggestion.name);
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const name of names) {
        next.add(name.toLowerCase());
      }
      return next;
    });
    const aiNames = names.filter((name) => aiSuggestionNames.has(name.toLowerCase()));
    dismissSuggestionBundle({
      bookmarkId: bookmark.id,
      aiSuggestionNames: aiNames,
      folderTokens: [],
      markSuggestionsReviewed,
      dismissFolderSuggestion,
    });
  };

  // A manual re-run is a deliberate "reconsider": forget prior dismissals so the
  // model can surface tags it still recommends (accepted tags stay applied).
  const handleSuggestAi = () => {
    clearReviewedSuggestions(bookmark.id);
    clearDismissedFolderSuggestions(bookmark.id);
    clearReviewedSummary(bookmark.id);
    // Also forget this session's not-yet-persisted tag dismissals, so a tag the
    // user waved off earlier this session can re-surface if the model still
    // recommends it (matches the durable "reconsider" above).
    setDismissed(new Set());
    void runOrganizeAction(async () => {
      const error = await requestAiEnrichment(bookmark.id);
      // The store is i18n-free and signals rate-limiting with a sentinel; localize
      // it here — unified with the same calm "postponed" copy the automatic
      // retry note uses, rather than a rate-limit-specific message.
      return error === AI_RATE_LIMITED ? t('detail.aiPostponed') : error;
    });
  };

  // A move (the bookmark already lives in a different collection, so `currentFrom`
  // is set) overwrites a user-chosen collection_id. The chip already shows
  // ~~from~~ → to, so instead of confirming we file it and offer a "Moved to {to}"
  // toast whose Undo restores the prior collection. An add overwrites nothing.
  const offerMoveUndo = (to: string) => {
    if (!currentFrom) {
      return;
    }
    const fromId = currentFrom.id;
    showToast(t('review.movedToast', { name: to }), {
      label: t('common.undo'),
      onPress: () => assignCollection(bookmark.id, fromId),
    });
  };

  // Record the folder suggestion as acted-on under every token that identifies it
  // (resolved id and/or the AI's proposed name), so it stays gone even if it
  // later flips between the "create" and "file into" forms. Both dismiss AND
  // accept route through here: accepting only files the bookmark in, which hides
  // the chip *while it stays there* — so without recording the decision, undoing
  // the move (or refiling elsewhere) would re-surface a recommendation the user
  // already acted on. Mirrors how accepting a tag records it as reviewed. At most
  // one chip shows at a time, so `folderTokens` already reflects it.
  const recordFolderActedOn = () =>
    recordFolderSuggestionActedOn(bookmark.id, folderTokens, dismissFolderSuggestion);
  const handleDismissFolder = recordFolderActedOn;

  // Accept the proposed summary into the note. Sacred-fields rule: the summary is
  // never poured into the note field silently — it lands only when the user taps
  // here. An empty note is filled; a note with text is *appended* to (never
  // overwritten), so the action stays live and non-destructive. `notesValue`
  // already folds in any in-progress draft, so we build on the latest text and
  // clear the draft (the store write supersedes it).
  const handleUseSummary = () => {
    const summary = enrichment?.summary?.trim();
    if (!summary) {
      return;
    }
    const nextNotes = notesValue.trim() === '' ? summary : `${notesValue}\n\n${summary}`;
    // Truncate the combined result (STASH-1J safety net). ProposedSummary is
    // non-destructive, but long summaries + existing notes could still exceed.
    const safeNotes = nextNotes.length > MAX_NOTES_LENGTH
      ? nextNotes.slice(0, MAX_NOTES_LENGTH)
      : nextNotes;
    updateBookmarkFields(bookmark.id, { notes: safeNotes });
    setDraftNotes(null);
    // Durable: don't re-surface an identical summary we've already used.
    if (summaryTok) {
      markSummaryReviewed(bookmark.id, summaryTok);
    }
  };

  // Dismiss the proposed summary — durable, mirroring tag/folder dismissals, so
  // an identical re-pull stays quiet (a genuinely new summary re-surfaces).
  const handleDismissSummary = () => {
    if (summaryTok) {
      markSummaryReviewed(bookmark.id, summaryTok);
    }
  };

  // Screen-level "no thanks to everything": now that folder, tags, and summary
  // live in three separate widgets, no single one can own the bulk gesture — so
  // it lives in the AI control strip and sweeps all three, each honoring its own
  // durability rule.
  const handleDismissAllSuggestions = () => {
    handleDismissAllTags();
    if (folderSuggestionVisible) {
      handleDismissFolder();
    }
    if (showAiSummary) {
      handleDismissSummary();
    }
  };

  const handleAcceptCollection = () => {
    if (!suggestedCollection) {
      return;
    }
    void runOrganizeAction(() =>
      acceptSuggestionBundle(suggestionActionDeps, {
        bookmarkId: bookmark.id,
        aiSuggestions: [],
        folder: suggestedFolder,
        folderTokens,
        createCollectionError: t('detail.errorCreateCollection'),
        onAcceptedFolder: (folder) => offerMoveUndo(folder.name),
      }),
    );
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

  // Accept the "create" folder suggestion: create the proposed name and file in.
  // When the bookmark already lives elsewhere this is a move, so offer the Undo
  // toast once the create+assign lands (an add overwrites nothing).
  const handleAcceptCreateCollection = () => {
    if (!suggestedFolder) {
      return;
    }
    void runOrganizeAction(() =>
      acceptSuggestionBundle(suggestionActionDeps, {
        bookmarkId: bookmark.id,
        aiSuggestions: [],
        folder: suggestedFolder,
        folderTokens,
        createCollectionError: t('detail.errorCreateCollection'),
        onAcceptedFolder: (folder) => offerMoveUndo(folder.name),
      }),
    );
  };

  const handleOpenLink = () => {
    if (bookmark.url) {
      markBookmarkAccessed(bookmark.id);
      void Linking.openURL(bookmark.url).catch(() => {
        setOrganizeError(t('detail.errorOpen'));
      });
    }
  };

  // STASH-61 recovery action: the saved video is confirmed gone, so offer a
  // one-tap YouTube search for its title — a re-upload or mirror is often
  // findable even when the original link is dead.
  const handleSearchYoutube = () => {
    const query = displayedTitle.trim();
    if (!query) {
      return;
    }
    void Linking.openURL(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    ).catch(() => {
      setOrganizeError(t('detail.errorOpen'));
    });
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

  // The folder recommendation, packaged for the TagField suggestion row: it
  // renders as the leading chip beside the tag suggestions. Accept files into
  // an existing match or creates the proposed name; dismiss is durable. null
  // when there's no folder hint (or it was dismissed / already filed there).
  const folderSuggestionChip = folderSuggestionVisible
    ? {
        label: (
          <FolderSuggestionLabel
            t={t}
            folder={suggestedFolder!}
            accentColor={palette.accent}
            secondaryColor={palette.textSecondary}
          />
        ),
        acceptA11y: folderChipA11yLabel(t, suggestedFolder!, displayedTitle),
        dismissA11y: showCollectionSuggestion
          ? t('detail.aiDismissCollectionA11y', { name: suggestedCollection!.name })
          : t('detail.aiDismissCollectionA11y', { name: suggestedByName! }),
        onAccept: showCollectionSuggestion ? handleAcceptCollection : handleAcceptCreateCollection,
        onDismiss: handleDismissFolder,
      }
    : null;

  const content = (
    <>
      {inline && onInlineClose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          testID="bookmark-inline-detail-close"
          hitSlop={8}
          onPress={onInlineClose}
          style={({ pressed }) => [
            styles.inlineClose,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Ionicons name="close" size={18} color={palette.textSecondary} />
        </Pressable>
      ) : null}
      {/* Prefer a captured image's local URI (image bookmarks) over a fetched
          preview; either renders the same hero. */}
      {(() => {
        if (isPreviewFailed) {
          return (
            <View
              style={[
                styles.previewFailedBanner,
                { backgroundColor: palette.dangerSoft, borderColor: palette.danger },
              ]}
            >
              <Ionicons name="warning-outline" size={24} color={palette.danger} />
              <Text style={[styles.previewFailedText, { color: palette.text }]}>
                {t('detail.previewFailedNote')}
              </Text>
            </View>
          );
        }
        if (hidePreviewHero) {
          return null;
        }
        const previewUri = bookmark.local_image_uri ?? bookmark.preview_image_url;
        if (!previewUri) {
          return null;
        }
        return bookmark.url ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('common.openLink')}
            onPress={handleOpenLink}
          >
            <Image
              testID="bookmark-detail-preview"
              source={{ uri: previewUri }}
              style={styles.preview}
              resizeMode="cover"
            />
          </Pressable>
        ) : (
          <Image
            testID="bookmark-detail-preview"
            source={{ uri: previewUri }}
            style={styles.preview}
            resizeMode="cover"
          />
        );
      })()}
      {/* Compact byline: favicon · host · status, instead of a header card. */}
      <View style={styles.byline}>
        {bookmark.favicon_url ? (
          <View style={[styles.bylineFavTile, { borderColor: palette.border }]}>
            <Image source={{ uri: bookmark.favicon_url }} style={styles.bylineFav} resizeMode="contain" />
          </View>
        ) : null}
        {/* `accessible` + `accessibilityLabel` on this outer View give
            VoiceOver/TalkBack the real byline as one announced unit (the
            masked Text below has no accessible ancestor of its own
            otherwise) — and, since `bylineText` carries `flex: 1` for the
            row layout, this View also carries that flex itself, since an
            unstyled PostHogMaskView wrapper wouldn't inherit it. */}
        <View
          accessible
          accessibilityLabel={`${host ?? t('detail.savedByline')}${
            statusChips.length > 0 ? `  ·  ${statusChips.join(' · ')}` : ''
          }`}
          style={styles.bylineTextWrap}
        >
          <PostHogMaskView>
            <Text style={[styles.bylineText, { color: palette.textSecondary }]} numberOfLines={1}>
              {host ?? t('detail.savedByline')}
              {statusChips.length > 0 ? `  ·  ${statusChips.join(' · ')}` : ''}
            </Text>
          </PostHogMaskView>
        </View>
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
            <PostHogMaskView>
              <Text
                style={[
                  styles.title,
                  {
                    color: isTitleDerived(bookmark) ? palette.textSecondary : palette.text,
                    fontWeight: isTitleDerived(bookmark) ? '500' : '800',
                  },
                ]}
                // Measure unclamped on first layout so overflow detection is
                // reliable across platforms; clamp once we know the line count.
                numberOfLines={
                  titleLineCount === null || titleExpanded ? undefined : TITLE_COLLAPSED_LINES
                }
                onTextLayout={(event) => {
                  // Only trust a real measurement. react-native-web can report an
                  // empty `lines` array; recording 0 would clamp the title to
                  // TITLE_COLLAPSED_LINES yet hide the toggle (0 is not > 4),
                  // stranding a long note with no way to see the full text ("long
                  // text silently cut off"). Staying null keeps it unclamped —
                  // the full text shows — until a trustworthy count arrives.
                  if (titleLineCount === null && event.nativeEvent.lines.length > 0) {
                    setTitleLineCount(event.nativeEvent.lines.length);
                  }
                }}
              >
                {displayedTitle}
              </Text>
            </PostHogMaskView>
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
        {bookmark.video_unavailable ? (
          <ActionButton
            icon="search-outline"
            label={t('detail.searchYoutube')}
            tint={palette.text}
            onPress={handleSearchYoutube}
          />
        ) : null}
        {bookmark.url || isTextMemo ? (
          <ActionButton icon="copy-outline" label={t('common.copy')} tint={palette.text} onPress={handleCopyLink} />
        ) : null}
        {bookmark.url || isTextMemo ? (
          <ActionButton icon="share-social" label={t('common.share')} tint={palette.text} onPress={handleShare} />
        ) : null}
        {bookmark.url ? (
          <ActionButton
            icon="refresh"
            label={previewRefreshing ? t('detail.previewRefreshing') : t('detail.previewRefresh')}
            tint={palette.text}
            disabled={busy || previewRefreshing}
            onPress={handleRefreshPreview}
          />
        ) : null}
        {bookmark.deleted_at ? (
          <ActionButton
            icon="arrow-undo"
            label={t('common.restore')}
            tint={palette.text}
            onPress={() => {
              restoreBookmark(bookmark.id);
              if (inline) {
                onInlineClose?.();
              } else {
                router.back();
              }
            }}
          />
        ) : (
          <ActionButton
            icon="trash"
            label={t('common.trash')}
            tint={palette.danger}
            onPress={() => {
              const trashedId = bookmark.id;
              trashBookmark(trashedId);
              // The toast lives above the navigator, so it survives the back nav;
              // its Undo is the immediate recovery path (vs. Settings → Trash).
              showToast(t('toast.trashed'), {
                label: t('common.undo'),
                onPress: () => restoreBookmark(trashedId),
              });
              if (inline) {
                onInlineClose?.();
              } else {
                router.back();
              }
            }}
          />
        )}
      </View>

      {/* Notes — a labeled section (the header names the field, so the box no
          longer needs a pencil glyph to avoid reading as a divider). Empty and
          unfocused, it's a light borderless prompt so a note-less bookmark
          doesn't show a big empty form; once it has text or focus, it becomes an
          elevated bordered box that grows with the content. */}
      {isTextMemo ? (
        <View style={styles.memoBlock}>
          <View style={styles.memoHeader}>
            <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
              {t('detail.memoContentLabel')}
            </Text>
            <View
              style={[
                styles.memoModeSwitch,
                { backgroundColor: palette.surface, borderColor: palette.border },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: !memoEditing }}
                onPress={() => {
                  commitDescription();
                  setMemoEditing(false);
                }}
                style={[
                  styles.memoModeButton,
                  !memoEditing && { backgroundColor: palette.accentSoft },
                ]}
              >
                <Text
                  style={[
                    styles.memoModeLabel,
                    { color: !memoEditing ? palette.accent : palette.textSecondary },
                  ]}
                >
                  {t('detail.memoPreview')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: memoEditing }}
                onPress={() => {
                  if (!memoEditing) {
                    setDraftDescription(bookmark.description ?? '');
                  }
                  setMemoEditing(true);
                }}
                style={[
                  styles.memoModeButton,
                  memoEditing && { backgroundColor: palette.accentSoft },
                ]}
              >
                <Text
                  style={[
                    styles.memoModeLabel,
                    { color: memoEditing ? palette.accent : palette.textSecondary },
                  ]}
                >
                  {t('detail.memoEdit')}
                </Text>
              </Pressable>
            </View>
          </View>
          {memoEditing ? (
            <TextInput
              accessibilityLabel={t('detail.memoBodyA11y')}
              autoFocus
              multiline
              maxLength={MAX_MEMO_LENGTH}
              placeholder={t('detail.memoBodyPlaceholder')}
              placeholderTextColor={palette.textSecondary}
              scrollEnabled
              style={[
                styles.memoInput,
                {
                  backgroundColor: palette.surfaceElevated,
                  borderColor: palette.border,
                  color: palette.text,
                },
              ]}
              value={memoValue}
              onChangeText={setDraftDescription}
              onBlur={commitDescription}
            />
          ) : (
            <Card elevated={false} style={styles.memoPreview}>
              <MarkdownBody markdown={bookmark.description ?? ''} />
            </Card>
          )}
        </View>
      ) : null}

      <View style={styles.notesBlock}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
          {t('detail.notesLabel')}
        </Text>
        <View
          style={[
            styles.notesBox,
            notesFilled
              ? { backgroundColor: palette.surfaceElevated, borderColor: palette.border }
              : styles.notesBoxEmpty,
            notesTooLong && { borderColor: palette.danger },
          ]}
        >
          <TextInput
            ref={notesRef}
            accessibilityLabel={t('detail.notesA11y')}
            style={[styles.notesInput, { color: palette.text }]}
            placeholder={t('detail.notesPlaceholder')}
            placeholderTextColor={palette.textSecondary}
            multiline
            maxLength={MAX_NOTES_LENGTH}
            value={notesValue}
            onChangeText={setDraftNotes}
            onFocus={() => setNotesFocused(true)}
            onBlur={() => {
              setNotesFocused(false);
              commitNotes();
            }}
            // Explicit scroll for the bounded maxHeight (native + web).
            scrollEnabled
          />
          {notesTooLong && (
            <Text style={[styles.error, { color: palette.danger, paddingTop: 4 }]}>
              {t('detail.notesTooLong', { count: notesLength, max: MAX_NOTES_LENGTH })}
            </Text>
          )}
        </View>
      </View>

      {/* The AI summary is proposed as a note here — in its own clearly-labeled
          dashed ghost block, never poured into the field above — so it can't be
          mistaken for user-authored text (sacred-fields principle). Accept fills
          an empty note or appends to a non-empty one; both are durable. */}
      {showAiSummary ? (
        <ProposedSummary
          summary={enrichment?.summary ?? ''}
          noteEmpty={notesValue.trim() === ''}
          busy={busy}
          onUse={handleUseSummary}
          onDismiss={handleDismissSummary}
        />
      ) : null}

      {/* Collection — no title; the folder-icon picker speaks for itself.
          It leads the organize controls, directly above the tag field. The AI's
          folder recommendation lives right under the picker (not inside its
          browse panel, which only exists while open) as a dashed ghost pill, so
          the suggestion reads as "a proposed value for *this* field". */}
      <View style={styles.collectionBlock}>
        <CollectionPicker
          collections={collections.map((item) => ({ id: item.id, name: item.name }))}
          currentId={bookmark.collection_id}
          currentName={collection?.name ?? null}
          busy={busy}
          onSelect={(value) => assignCollection(bookmark.id, value)}
          onCreate={handleCreateCollection}
        />
        {folderSuggestionChip ? (
          <View style={styles.folderSuggestionBlock}>
            <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
              {t('detail.suggestedCollectionLabel')}
            </Text>
            <View style={styles.folderSuggestionRow}>
              <View style={[styles.ghostChip, { borderColor: palette.accent }]}>
                {/* The whole label + ✓ is one accept target (tap anywhere on it
                    files the bookmark) — the explicit ✓ removes any "does this
                    open the picker?" doubt now that the pill sits beside a
                    tappable picker row, matching Review's tap-to-accept chip. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={folderSuggestionChip.acceptA11y}
                  disabled={busy}
                  style={styles.folderAccept}
                  onPress={folderSuggestionChip.onAccept}
                >
                  <PostHogMaskView>
                    <Text style={styles.ghostLabel}>{folderSuggestionChip.label}</Text>
                  </PostHogMaskView>
                  <Text style={[styles.ghostAccept, { color: palette.accent }]}>{' ✓'}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={folderSuggestionChip.dismissA11y}
                  disabled={busy}
                  hitSlop={6}
                  onPress={folderSuggestionChip.onDismiss}
                >
                  <Text style={[styles.ghostRemove, { color: palette.textSecondary }]}>✕</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
        {collection && !collections.some((item) => item.id === collection.id) ? (
          // `accessible` + `accessibilityLabel` on this outer View gives
          // screen readers the real text as one announced unit; the masked
          // Text below it still hides the collection name from replay
          // recordings without also hiding it from VoiceOver/TalkBack (a
          // standalone masked Text with no accessible ancestor of its own
          // risks being skipped or announced as the mask's own sentinel
          // label instead of its real content).
          <View
            accessible
            accessibilityLabel={t('detail.currentlyIn', { name: collection.name })}
          >
            <PostHogMaskView>
              <Text style={[styles.hint, { color: palette.textSecondary }]}>
                {t('detail.currentlyIn', { name: collection.name })}
              </Text>
            </PostHogMaskView>
          </View>
        ) : null}
      </View>

      {/* Tags sit under the folder picker as a compact token field. The folder
          recommendation now lives under the picker (above), so this field's
          suggestion row and its "Add all"/"Dismiss all" are tags-only — the
          bulk actions plainly mean "these tags". */}
      <TagField
        tags={tags.map((tag) => ({ id: tag.id, name: tag.name }))}
        suggestions={tagSuggestions}
        editable={canOrganizeRemotely}
        busy={busy}
        onAdd={handleAddTag}
        onRemove={handleRemoveTag}
        onBrowse={(tagId) => {
          // dismissTo (not navigate): browsing a tag means "go to the Inbox
          // filtered by it", so dismiss back to the root Inbox and apply the
          // facet — never leave this detail (or an intermediate Review/Trash)
          // stacked beneath. Falls back to a replace if Detail was reached cold
          // (deep link, no Inbox beneath). The `t` nonce makes a same-tag
          // re-browse re-apply past the Inbox handler's (tag + t) dedupe. It
          // comes from the shared module counter, not a per-screen ref: dismissTo
          // tears this screen down, so a ref would reset to 0 and re-emit the
          // same nonce, which the Inbox would skip as already-consumed (STASH-D).
          onInlineClose?.();
          router.dismissTo({
            pathname: '/',
            params: { tag: tagId, t: nextFacetNonce() },
          });
        }}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={handleDismissTag}
        onAcceptAllSuggestions={handleAcceptAll}
        onDismissAllSuggestions={handleDismissAllTags}
        disabledHint={
          canOrganizeRemotely ? undefined : t('detail.tagsDisabledHint')
        }
      />

      {/* AI suggestions — no redundant header; the action button names itself. */}
      <Card elevated={false} style={styles.field}>
        {aiWorking && !hadPriorEnrichmentAttempt(bookmark.id) ? (
          // Ambient placeholder: suggestions are filling in. Deliberately not a
          // centered spinner + "working…" label, which reads as a modal wait —
          // the screen stays fully interactive while this pulses. Only for the
          // very first attempt — on an automatic retry the postponed note
          // below stays put instead, so it doesn't flash "any second now" and
          // then go quiet again each time.
          <SuggestionSkeleton style={styles.suggestHeader} />
        ) : enrichment?.model && showAiReport ? (
          <View style={styles.suggestHeader}>
            <View style={[styles.aiBadge, { borderColor: palette.border }]}>
              <Text style={[styles.aiBadgeLabel, { color: palette.textSecondary }]}>
                {enrichment.model}
              </Text>
            </View>
          </View>
        ) : null}

        {enrichment?.status === 'stale' && showAiReport ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>{t('detail.aiStale')}</Text>
        ) : null}

        {aiServerQueued ? (
          // A CONFIRMED server-side queue entry outranks the generic
          // "postponed" note below: armAiRetry arms unconditionally on every
          // failure (this 429 included), so aiPostponed is also true here —
          // but this is the stronger, self-resolving promise, so it wins.
          <Text
            accessibilityRole="text"
            style={[styles.hint, { color: palette.textSecondary }]}
          >
            {t('detail.aiQueued')}
          </Text>
        ) : aiPostponed ? (
          // A live, currently-armed retry marker (waiting out its backoff)
          // always wins over showDegradedNote below: that note can describe a
          // stale, already-completed attempt, while this reflects the
          // bookmark's current, most relevant state — an actual background
          // retry really is scheduled here.
          <Text
            accessibilityRole="text"
            style={[styles.hint, { color: palette.textSecondary }]}
          >
            {t('detail.aiPostponed')}
          </Text>
        ) : showDegradedNote ? (
          <Text
            accessibilityRole="text"
            style={[styles.hint, { color: palette.textSecondary }]}
          >
            {/* When the card is collapsed (nothing actionable) there are no
                "basic suggestions" on screen to point at, so fall back to a
                standalone note — but never the "aiPostponed" copy: this is a
                *completed* (if degraded) attempt with no armed retry marker,
                so promising an automatic retry here would be false. */}
            {showAiReport
              ? enrichmentDegradedLabel(t, enrichment?.degraded_reason ?? null)
              : t('detail.aiDegradedCollapsed')}
          </Text>
        ) : null}

        {isPreviewFailed ? (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            {t('detail.aiPreviewFailed')}
          </Text>
        ) : canOrganizeRemotely ? (
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

        {/* One "no thanks to everything" gesture, at bulk scope — shown only when
            suggestions span 2+ widgets, since with one live surface that widget's
            own dismiss suffices. There is deliberately no "Accept all": accepting
            the summary mutates the user's note, so accepts stay in-context. */}
        {showDismissAllSuggestions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('detail.aiDismissAllA11y')}
            disabled={busy}
            hitSlop={6}
            style={styles.dismissAll}
            onPress={handleDismissAllSuggestions}
          >
            <Ionicons name="close-circle-outline" size={14} color={palette.textSecondary} />
            <Text style={[styles.dismissAllLabel, { color: palette.textSecondary }]}>
              {t('detail.aiDismissAll')}
            </Text>
          </Pressable>
        ) : null}
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
                // `accessible` + `accessibilityLabel` combine the label and
                // value into one announced unit for VoiceOver/TalkBack — the
                // masked value Text below has no accessible ancestor of its
                // own otherwise, and could be skipped or announced as the
                // mask's own sentinel label instead of its real content.
                accessible
                accessibilityLabel={`${row.label}: ${row.value}`}
                style={[
                  styles.detailRow,
                  index > 0
                    ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }
                    : null,
                ]}
              >
                <Text style={[styles.detailLabel, { color: palette.textSecondary }]}>{row.label}</Text>
                <PostHogMaskView>
                  <Text style={[styles.detailValue, { color: palette.text }]} selectable>
                    {row.value}
                  </Text>
                </PostHogMaskView>
              </View>
            ))}
          </Card>
        ) : null}
      </View>

      {organizeError ? <Text style={[styles.error, { color: palette.danger }]}>{organizeError}</Text> : null}
      {/* Report flow cleanup for STASH-1H: always clear any lingering error state
          (organize or notes-too-long) when leaving the screen. Prevents stale red
          borders/messages on re-open. */}
    </>
  );

  if (inline) {
    return (
      <View
        testID="bookmark-inline-detail"
        style={[
          styles.container,
          styles.inlineContainer,
          {
            backgroundColor: palette.surfaceElevated,
            borderColor: palette.border,
            paddingBottom: 16,
          },
        ]}
      >
        {content}
      </View>
    );
  }

  return (
    <KeyboardAvoidingScreen style={{ backgroundColor: palette.background }}>
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 32 }]}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

/** One item in the detail action bar: a vector icon above a small label. */
function ActionButton({
  icon,
  label,
  tint,
  disabled = false,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  tint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: palette.card,
          borderColor: palette.border,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
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
  inlineContainer: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    marginTop: 2,
    marginBottom: 10,
  },
  inlineClose: {
    alignSelf: 'flex-end',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: -8,
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
  bylineTextWrap: {
    flex: 1,
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
    flexWrap: 'wrap',
    gap: 10,
  },
  action: {
    flex: 1,
    minWidth: 76,
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
  memoBlock: {
    gap: 10,
  },
  memoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  memoModeSwitch: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 2,
    gap: 2,
  },
  memoModeButton: {
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: 9,
    paddingHorizontal: 10,
  },
  memoModeLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  memoPreview: {
    borderRadius: 18,
    padding: 18,
  },
  memoInput: {
    minHeight: 220,
    maxHeight: 420,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 16,
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  folderSuggestionBlock: {
    gap: 6,
    marginTop: 2,
  },
  folderSuggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  folderAccept: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Dashed ghost pill matching the tag suggestion chips (TagField), so the folder
  // recommendation reads in the same visual language across surfaces.
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
  ghostAccept: {
    fontSize: 13,
    fontWeight: '700',
  },
  ghostRemove: {
    fontSize: 12,
    fontWeight: '700',
  },
  dismissAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  dismissAllLabel: {
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
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
  notesBlock: {
    gap: 6,
  },
  notesBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  // Empty & unfocused: no fill or border (a transparent border keeps the height
  // steady when it flips to the contained state), flush left as a plain prompt.
  notesBoxEmpty: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    paddingHorizontal: 0,
  },
  notesInput: {
    fontSize: 15,
    // Android shaves the tops of the first line of a top-aligned multiline
    // TextInput when it sits flush to the content box: a small paddingTop gives
    // the ascenders room, lineHeight guarantees vertical space regardless of the
    // device font, and includeFontPadding:false keeps first-line placement
    // consistent across Android fonts so it doesn't regress elsewhere.
    lineHeight: 21,
    includeFontPadding: false,
    paddingTop: 2,
    paddingBottom: 0,
    paddingHorizontal: 0,
    minHeight: 40,
    // Bounded growth prevents very long memos (STASH-1J/1H) from pushing the
    // entire Detail layout off-screen or breaking ScrollView/KeyboardAvoidingScreen.
    // 8 lines (~170px) is generous for most notes; inner scroll appears for longer.
    maxHeight: 170,
    textAlignVertical: 'top',
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  previewFailedBanner: {
    width: '100%',
    height: 220,
    borderRadius: 28,
    borderWidth: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  previewFailedText: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
});
