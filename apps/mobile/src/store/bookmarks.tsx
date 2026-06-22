import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  mockBookmarkTags,
  mockBookmarks,
  mockCollections,
  mockEnrichments,
  mockTags,
  mockUserId,
} from '@/domain/mock-data';
import { canonicalizeUrl, normalizeUrl } from '@/domain/urls';
import { enrichBookmark } from '@/domain/enrichment';
import {
  imageTitleFromFileName,
  localImageFileName,
  type SharedImage,
} from '@/domain/image-share';
import type { ImportItem } from '@/domain/import';
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  LocalPendingBookmark,
  SuggestedTag,
  Tag,
} from '@/domain/types';
import { sanitizeTagData } from '@/domain/tag-data';
import { normalizeTag } from '@/domain/tag-input';
import {
  addReviewedNames,
  parseReviewedMap,
  pendingSuggestions,
  reviewedNamesFor,
  type ReviewedSuggestionMap,
} from '@/domain/ai-suggestions';
import {
  applyPendingTagOps,
  applyTagOp,
  dequeueTagOp,
  enqueueTagOp,
  reconcileSyncedAdd,
  type PendingTagOp,
} from '@/domain/pending-tags';
import { useI18n } from '@/i18n';
import { recordLog } from '@/observability/log-buffer';
import { repository } from '@/storage/repository';
import { copyImageToLibrary } from '@/storage/image-store';
import type { EnrichmentMetadataHint } from '@/api/bookmarks';
import type { TagData } from '@/storage/types';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { SupabaseRequestError } from '@/supabase/client';
import { applyAccountTransition, planAccountTransition } from '@/sync/account-transition';
import {
  LAST_PULLED_AT_KEY,
  SYNCED_USER_ANON_KEY,
  SYNCED_USER_ID_KEY,
  pullRemoteChanges,
} from '@/sync/pull-bookmarks';
import {
  createSyncApi,
  hasRemoteIdentity,
  isSyncable,
  makeMutationEntry,
  planLeftoverReconciliation,
  reconcileOrphanedQueueEntries,
  removeQueueEntryIfNotSuperseded,
  syncQueueEntry,
} from '@/sync/sync-bookmarks';

export type AddBookmarkResult =
  | {
      status: 'created' | 'duplicate';
      bookmark: Bookmark;
      /**
       * Resolves once the optimistic save has been flushed to durable storage:
       * `true` when it was written, `false` when the write failed (the row then
       * survives only in optimistic React state + the in-memory queue). It never
       * rejects — storage errors are logged. Callers that tear the app down right
       * after a capture (e.g. the share handler backgrounding the app on Android)
       * MUST await this and only proceed on `true`, so a capture is never lost to
       * an in-flight or failed SQLite write. Capture is sacred.
       */
      persisted: Promise<boolean>;
    }
  | { status: 'invalid'; error: string };

/** Outcome counts from re-ingesting an imported file. */
export interface ImportSummary {
  /** Bookmarks newly added to the library. */
  imported: number;
  /** Items skipped because their URL already exists in the library. */
  duplicates: number;
  /** Items skipped for lacking a usable URL (e.g. text-only saves). */
  skipped: number;
}

interface BookmarksContextValue {
  /** True until the durable store has been read on startup. */
  isLoading: boolean;
  /** Set when the durable store failed to load and in-memory fallback is used. */
  loadError: boolean;
  /** Active (non-trashed) bookmarks, newest first. */
  inbox: Bookmark[];
  /** Trashed bookmarks, most recently trashed first. */
  trash: Bookmark[];
  /** Offline sync queue, oldest first — exposed for inspection until sync exists. */
  queue: LocalPendingBookmark[];
  getBookmark: (id: string) => Bookmark | undefined;
  getTagsForBookmark: (id: string) => Tag[];
  getCollection: (id: string | null) => Collection | undefined;
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  /** Local-first creation: the bookmark is visible immediately with pending states. */
  addBookmark: (input: {
    url?: string;
    title?: string;
    notes?: string;
    /** Shared text with no usable URL — saved as a text note. */
    shared_text?: string;
    /** A shared image to capture as an image bookmark (local-only for now). */
    image?: SharedImage;
  }) => AddBookmarkResult;
  /**
   * Re-ingest items parsed from an imported file. Local-first like addBookmark:
   * each URL is added with pending states, deduped against the existing library
   * (and within the batch). Returns a count summary. Note: tags/collections from
   * the source are not restored yet — see the import UI copy.
   */
  importBookmarks: (items: ImportItem[]) => ImportSummary;
  /** Move a bookmark to the trash (soft delete). */
  trashBookmark: (id: string) => void;
  /** Restore a trashed bookmark back to the inbox. */
  restoreBookmark: (id: string) => void;
  /** Permanently delete all trashed bookmarks. */
  emptyTrash: () => void;
  /** Edit a bookmark's title/notes. Local-first; empty strings clear the field. */
  updateBookmarkFields: (id: string, fields: { title?: string; notes?: string }) => void;
  /** Permanently remove a bookmark and any pending queue entry for it. */
  deleteBookmark: (id: string) => void;
  /** True while the background sync service is uploading queue entries. */
  isSyncing: boolean;
  /** Upload pending/failed queue entries to Supabase. No-op without auth. */
  syncNow: () => Promise<void>;
  /** When the last successful pull from Supabase completed, if ever. */
  lastPulledAt: string | null;
  /** The user's cloud collections (assignable; refreshed by pull sync). */
  collections: Collection[];
  /** Add tags to a synced bookmark. Resolves to an error message, or null. */
  addTagsToBookmark: (bookmarkId: string, names: string[]) => Promise<string | null>;
  /** Remove a tag from a synced bookmark. Resolves to an error message, or null. */
  removeTagFromBookmark: (bookmarkId: string, tagName: string) => Promise<string | null>;
  /** Generate AI suggestions for a synced bookmark. Resolves to an error, or
   *  null. `source` defaults to 'manual' (an explicit user tap); the deferred
   *  post-capture auto-trigger passes 'auto' so the UI can stay silent for work
   *  the user never asked to wait on. */
  requestAiEnrichment: (
    bookmarkId: string,
    source?: 'auto' | 'manual',
  ) => Promise<string | null>;
  /** True while ANY AI request (auto or manual) is in flight for this bookmark —
   *  drives the ambient "filling in" placeholder. */
  isEnriching: (bookmarkId: string) => boolean;
  /** True only while a user-initiated ("Suggest with AI"/refresh) request is in
   *  flight — drives the explicit button feedback, so the auto-trigger never
   *  makes the section look like it's blocking on a wait. */
  isManuallyEnriching: (bookmarkId: string) => boolean;
  /** Accept AI-suggested tags (linked with source 'ai'). Resolves to an error, or null. */
  acceptSuggestedTags: (bookmarkId: string, suggestions: SuggestedTag[]) => Promise<string | null>;
  /**
   * Suggestion names the user has already reviewed (accepted or dismissed) for
   * a bookmark, lowercased. Pass to `pendingSuggestions` so the "✨" badge
   * counts only *unreviewed* suggestions — accepting then removing a tag does
   * not bring the badge back.
   */
  getReviewedSuggestions: (bookmarkId: string) => Set<string>;
  /** Mark suggestion names as reviewed for a bookmark (durable). Accepting tags
   *  records this automatically; dismissing a suggestion calls it directly. */
  markSuggestionsReviewed: (bookmarkId: string, names: string[]) => void;
  /** Forget a bookmark's reviewed names so a manual AI re-run can re-surface
   *  previously-dismissed suggestions. Background sync never clears them. */
  clearReviewedSuggestions: (bookmarkId: string) => void;
  /**
   * Bookmark ids whose AI suggestions arrived while the user wasn't looking
   * (background auto-enrichment, a server-side trigger, or another device's
   * enrichment pulled in). Drives the Inbox "new AI suggestions" banner. An id
   * stays until the user witnesses it via {@link markSuggestionsSeen} or
   * {@link clearUnseenSuggestions}; the banner intersects this with the live
   * pending list, so an id whose suggestions were since applied stops counting.
   */
  unseenSuggestionIds: ReadonlySet<string>;
  /** Forget that a bookmark's suggestions were "new" — called when the user
   *  opens its Detail (witnesses the suggestions). Durable. */
  markSuggestionsSeen: (bookmarkId: string) => void;
  /** Clear every "new AI suggestions" marker at once — called when the user
   *  opens the Review screen (witnesses them all). Durable. */
  clearUnseenSuggestions: () => void;
  /** Move a bookmark into a collection (or out, with null). Local-first. */
  assignCollection: (bookmarkId: string, collectionId: string | null) => void;
  /** Create a cloud collection. Resolves to the collection or an error message. */
  createCollection: (name: string) => Promise<{ collection?: Collection; error?: string }>;
}

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };

/** Durable key for the local-first tag operation queue (JSON in meta). */
const PENDING_TAG_OPS_KEY = 'pending_tag_ops';

/** Durable key (JSON id array in meta) for bookmarks awaiting their first auto
 *  AI enrichment. Persisted so a kill during the metadata-fetch window doesn't
 *  drop the auto-trigger — the marker is re-hydrated and fired on next launch. */
const PENDING_AI_TRIGGER_KEY = 'pending_ai_trigger';

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for AI suggestion
 *  names the user has reviewed (accepted or dismissed). Drives the "✨" badge so
 *  it reflects *unreviewed* suggestions rather than merely *un-applied* ones. */
const REVIEWED_SUGGESTIONS_KEY = 'reviewed_ai_suggestions';

/** Durable key (JSON id array in meta) for bookmarks whose AI suggestions
 *  arrived while the user wasn't looking — a background auto-enrichment, a
 *  server-side trigger result, or another device's enrichment pulled in. Drives
 *  the Inbox "new AI suggestions" banner so freshly-suggested items aren't
 *  stranded behind a per-card badge the user has to scroll to find; an id is
 *  cleared once the user witnesses it (opens its Detail, or visits Review).
 *  Persisted so a suggestion that landed in a session the user never returned to
 *  still announces itself on the next launch. */
const UNSEEN_SUGGESTIONS_KEY = 'unseen_ai_suggestions';

/** Opaque sentinel `requestAiEnrichment` returns when the AI endpoint rate-limits
 *  (HTTP 429). The store is i18n-free, so it can't localize the message itself;
 *  the Detail screen maps this to a translated string. Any non-UI caller (the
 *  deferred auto-trigger) only checks for a non-null error, so the value is
 *  inert there. */
export const AI_RATE_LIMITED = 'ai-rate-limited';

function parseIdSet(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

const BookmarksContext = createContext<BookmarksContextValue | null>(null);

function makeLocalId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A UUID-format capture id for {@link Bookmark.client_id}. Prefers the platform
 * crypto when present (web, modern Hermes, the Node test runner) and otherwise
 * falls back to a Math.random v4 — this is a server-side dedupe key, not a
 * secret, so it only needs to be unique, not cryptographically strong. The
 * cloud `bookmarks.client_id` column is `uuid`, so the format must be valid.
 */
function makeClientId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * The current canonical dedupe key for an already-stored bookmark. Recomputed
 * from the URL rather than trusting the persisted `url_hash`, so a row saved by
 * an older build — whose hash predates a canonicalization change (e.g. the
 * YouTube `si` strip) and hasn't yet been rewritten by pull sync — still
 * dedupes against a fresh save instead of creating the duplicate this is meant
 * to prevent. Falls back to the stored hash when the row has no URL.
 */
function currentDedupeKey(bookmark: Pick<Bookmark, 'url' | 'url_hash'>): string | null {
  return bookmark.url ? canonicalizeUrl(bookmark.url) : bookmark.url_hash;
}

/** Parse the persisted tag-op queue, tolerating absent/corrupt values. */
function parseTagOps(raw: string | null): PendingTagOp[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (op): op is PendingTagOp =>
            !!op &&
            typeof op.bookmark_id === 'string' &&
            typeof op.tag_name === 'string' &&
            (op.op === 'add' || op.op === 'remove'),
        )
      : [];
  } catch {
    return [];
  }
}

function logStorageError(operation: string, error: unknown) {
  console.warn(`[stash] failed to persist ${operation}; state remains in memory`, error);
}

// Single shared init so background writes can never race ahead of table
// creation/seeding, even for saves made before the startup load finishes.
let repositoryReady: Promise<void> | null = null;
function ensureRepositoryReady(): Promise<void> {
  if (!repositoryReady) {
    // Seed the sample tags/links/collections and enrichments alongside the
    // bookmarks so the synced samples behave like real cloud rows (e.g. their
    // collection is assignable, not just a label) instead of leaning on the
    // in-memory fallbacks in getCollection/getTagsForBookmark/getEnrichment.
    repositoryReady = repository.init(
      mockBookmarks,
      { tags: mockTags, bookmarkTags: mockBookmarkTags, collections: mockCollections },
      mockEnrichments,
    );
    // A failed init must not poison the whole session — clear the cached
    // rejection so the next call retries (e.g. after a transient warm-start
    // open failure).
    repositoryReady.catch(() => {
      repositoryReady = null;
    });
  }
  return repositoryReady;
}

/** Append items from `loaded` that aren't already present (by key). */
function mergeById<T>(current: T[], loaded: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...loaded.filter((item) => !seen.has(key(item)))];
}

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const auth = useSupabaseAuth();
  // The active language, sent with AI enrichment requests so the model answers
  // in the user's locale (M12). Read through a ref so requestAiEnrichment stays
  // stable as the locale changes — it just picks up the latest value when fired.
  const { locale } = useI18n();
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [queue, setQueue] = useState<LocalPendingBookmark[]>([]);
  const [enrichments, setEnrichments] = useState<AIEnrichment[]>([]);
  const [tagData, setTagData] = useState<TagData>(EMPTY_TAG_DATA);
  // Local-first tag add/remove operations awaiting upload. The displayed
  // tagData is the server snapshot with these layered on top.
  const [pendingTagOps, setPendingTagOps] = useState<PendingTagOp[]>([]);
  const pendingTagOpsRef = useRef<PendingTagOp[]>([]);
  // Suggestion names the user has reviewed (accepted or dismissed) per bookmark.
  // The ref mirrors state so the accept path can merge synchronously.
  const [reviewedSuggestions, setReviewedSuggestions] = useState<ReviewedSuggestionMap>({});
  const reviewedSuggestionsRef = useRef<ReviewedSuggestionMap>({});
  // Bookmark ids whose AI suggestions arrived unwitnessed (drives the Inbox
  // banner). The ref mirrors state so the arrival paths (auto enrichment, pull)
  // can read-modify-write synchronously across back-to-back updates.
  const [unseenSuggestionIds, setUnseenSuggestionIds] = useState<ReadonlySet<string>>(new Set());
  const unseenSuggestionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const syncInFlight = useRef(false);
  // The user id the pull effect last fired for. A sign-in (anonymous → real)
  // or account switch changes this, re-triggering a pull; null until the first
  // session is established.
  const lastSyncedUserId = useRef<string | null>(null);
  // Bookmark IDs currently being enriched, so concurrent passes (startup +
  // a fresh save) never double-process the same item.
  const enriching = useRef(new Set<string>());
  // Bookmark IDs with an AI enrichment request in flight, so an auto-trigger
  // and a manual "Suggest with AI" tap never fire duplicate requests.
  const aiEnriching = useRef(new Set<string>());
  // Freshly created bookmarks awaiting their first auto AI enrichment. We hold
  // them here until metadata enrichment settles (see the effect below) so the
  // model never reasons about a bare, not-yet-enriched URL. Mirrored durably in
  // meta (PENDING_AI_TRIGGER_KEY) so the trigger survives an app kill during the
  // metadata-fetch window. Cleared only once enrichment succeeds.
  const pendingAiTrigger = useRef(new Set<string>());
  // Ids already attempted this session, so the effect doesn't re-fire on every
  // render while a marker lingers (e.g. after a failed request). In-memory on
  // purpose: a fresh launch retries a marker that never succeeded.
  const aiTriggerAttempted = useRef(new Set<string>());
  // Reactive mirror of `aiEnriching` so the UI can show an ambient "filling in"
  // placeholder while a request (auto-triggered or manual) is in flight.
  const [enrichingIds, setEnrichingIds] = useState<ReadonlySet<string>>(new Set());
  // Subset of `enrichingIds` started by an explicit user action, so the UI can
  // give direct button feedback for a manual tap while keeping the auto-trigger
  // silent (it should just fill suggestions in, not look like a blocking wait).
  const [manualEnrichingIds, setManualEnrichingIds] = useState<ReadonlySet<string>>(new Set());
  // Tombstones for deleted local bookmarks. The sync loop iterates over a
  // snapshot, so a delete that lands mid-run must be visible to it — both
  // before uploading an entry and before applying an upload's result.
  const deletedIds = useRef(new Set<string>());
  // Mirror of the bookmarks state so async loops can read the LATEST rows
  // instead of the stale closure captured when they started.
  const bookmarksRef = useRef<Bookmark[] | null>(null);
  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);
  const queueRef = useRef<LocalPendingBookmark[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  const tagDataRef = useRef<TagData>(EMPTY_TAG_DATA);
  useEffect(() => {
    tagDataRef.current = tagData;
  }, [tagData]);
  // Mirror of the enrichments state so the edit path can read the LATEST rows
  // synchronously when deciding whether to mark suggestions stale.
  const enrichmentsRef = useRef<AIEnrichment[]>([]);
  useEffect(() => {
    enrichmentsRef.current = enrichments;
  }, [enrichments]);
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  // Apply + persist a new tag-data snapshot in one step. The ref is updated
  // synchronously so a follow-up tag op in the same tick reads the latest.
  const applyTagData = useCallback((next: TagData) => {
    tagDataRef.current = next;
    setTagData(next);
    ensureRepositoryReady()
      .then(() => repository.replaceTagData(next))
      .catch((error) => logStorageError('tag data', error));
  }, []);

  // Persist the local-first tag-op queue (ref updated synchronously).
  const applyTagOps = useCallback((next: PendingTagOp[]) => {
    pendingTagOpsRef.current = next;
    setPendingTagOps(next);
    ensureRepositoryReady()
      .then(() => repository.setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(next)))
      .catch((error) => logStorageError('tag ops', error));
  }, []);

  // Apply + persist the reviewed-suggestions map (ref updated synchronously so
  // a follow-up read in the same tick sees the latest).
  const applyReviewedSuggestions = useCallback((next: ReviewedSuggestionMap) => {
    reviewedSuggestionsRef.current = next;
    setReviewedSuggestions(next);
    ensureRepositoryReady()
      .then(() => repository.setMeta(REVIEWED_SUGGESTIONS_KEY, JSON.stringify(next)))
      .catch((error) => logStorageError('reviewed suggestions', error));
  }, []);

  const markSuggestionsReviewed = useCallback(
    (bookmarkId: string, names: string[]) => {
      const next = addReviewedNames(reviewedSuggestionsRef.current, bookmarkId, names);
      // addReviewedNames returns the same reference when nothing new was added.
      if (next !== reviewedSuggestionsRef.current) {
        applyReviewedSuggestions(next);
      }
    },
    [applyReviewedSuggestions],
  );

  const getReviewedSuggestions = useCallback(
    (bookmarkId: string) => reviewedNamesFor(reviewedSuggestions, bookmarkId),
    [reviewedSuggestions],
  );

  // Forget a bookmark's reviewed names so a *manual* AI re-run can re-surface
  // suggestions the user previously dismissed (accepted ones stay applied, so
  // they're filtered by appliedTagNames regardless). Background sync never
  // calls this — only an explicit "Suggest with AI" tap.
  const clearReviewedSuggestions = useCallback(
    (bookmarkId: string) => {
      const current = reviewedSuggestionsRef.current;
      if (!(bookmarkId in current)) {
        return;
      }
      const next = { ...current };
      delete next[bookmarkId];
      applyReviewedSuggestions(next);
    },
    [applyReviewedSuggestions],
  );

  // Apply + persist the "unseen AI suggestions" id set (ref updated
  // synchronously so back-to-back arrivals accumulate correctly).
  const applyUnseenSuggestions = useCallback((next: ReadonlySet<string>) => {
    unseenSuggestionIdsRef.current = next;
    setUnseenSuggestionIds(next);
    ensureRepositoryReady()
      .then(() => repository.setMeta(UNSEEN_SUGGESTIONS_KEY, JSON.stringify([...next])))
      .catch((error) => logStorageError('unseen suggestions', error));
  }, []);

  // The bookmark's currently-applied tag names, lowercased — read off the ref so
  // it's usable from the synchronous arrival paths (mirrors getTagsForBookmark's
  // cloud-link lookup, without the seeded-sample fallback those rows don't need).
  const appliedTagNamesRef = useCallback((bookmarkId: string): Set<string> => {
    const data = tagDataRef.current;
    const linkedIds = new Set(
      data.bookmarkTags.filter((link) => link.bookmark_id === bookmarkId).map((l) => l.tag_id),
    );
    return new Set(
      data.tags.filter((tag) => linkedIds.has(tag.id)).map((tag) => tag.name.toLowerCase()),
    );
  }, []);

  // Record that an enrichment arrived unwitnessed: flag its bookmark for the
  // Inbox banner, but only if it actually carries a suggestion the user hasn't
  // already applied or reviewed (an enrichment that's all summary / already
  // handled tags is not worth announcing).
  const noteUnseenSuggestions = useCallback(
    (enrichment: AIEnrichment) => {
      const id = enrichment.bookmark_id;
      if (unseenSuggestionIdsRef.current.has(id)) {
        return;
      }
      const applied = appliedTagNamesRef(id);
      const reviewed = reviewedNamesFor(reviewedSuggestionsRef.current, id);
      if (pendingSuggestions(enrichment, applied, reviewed).length === 0) {
        return;
      }
      const next = new Set(unseenSuggestionIdsRef.current);
      next.add(id);
      applyUnseenSuggestions(next);
    },
    [appliedTagNamesRef, applyUnseenSuggestions],
  );

  const markSuggestionsSeen = useCallback(
    (bookmarkId: string) => {
      if (!unseenSuggestionIdsRef.current.has(bookmarkId)) {
        return;
      }
      const next = new Set(unseenSuggestionIdsRef.current);
      next.delete(bookmarkId);
      applyUnseenSuggestions(next);
    },
    [applyUnseenSuggestions],
  );

  const clearUnseenSuggestions = useCallback(() => {
    if (unseenSuggestionIdsRef.current.size === 0) {
      return;
    }
    applyUnseenSuggestions(new Set());
  }, [applyUnseenSuggestions]);

  // Mirror the deferred AI-trigger set to durable meta after a ref mutation.
  const persistPendingAiTrigger = useCallback(() => {
    const ids = [...pendingAiTrigger.current];
    ensureRepositoryReady()
      .then(() => repository.setMeta(PENDING_AI_TRIGGER_KEY, JSON.stringify(ids)))
      .catch((error) => logStorageError('ai trigger queue', error));
  }, []);
  const markPendingAiTrigger = useCallback(
    (id: string) => {
      pendingAiTrigger.current.add(id);
      persistPendingAiTrigger();
    },
    [persistPendingAiTrigger],
  );
  const clearPendingAiTrigger = useCallback(
    (id: string) => {
      if (pendingAiTrigger.current.delete(id)) {
        persistPendingAiTrigger();
      }
    },
    [persistPendingAiTrigger],
  );

  // Queue a remote mutation for a bookmark that already exists on the server.
  // One entry per bookmark: a newer mutation supersedes an older one.
  const enqueueMutation = useCallback((bookmarkId: string, operation: 'update' | 'delete') => {
    const entry = makeMutationEntry(bookmarkId, operation);
    setQueue((current) => [...current.filter((queued) => queued.local_id !== bookmarkId), entry]);
    ensureRepositoryReady()
      .then(() => repository.enqueue(entry))
      .catch((error) => logStorageError(`${operation} mutation enqueue`, error));
  }, []);

  // Fire-and-forget metadata enrichment. Runs off the save path so capture is
  // never blocked, only fills generated fields, and a failure just records a
  // failed status — it never affects bookmark creation.
  const enrichInBackground = useCallback((bookmark: Bookmark) => {
    if (bookmark.metadata_status !== 'pending' || enriching.current.has(bookmark.id)) {
      return;
    }
    enriching.current.add(bookmark.id);
    (async () => {
      try {
        const { patch, metadata_status } = await enrichBookmark(bookmark);
        if (deletedIds.current.has(bookmark.id)) {
          return; // deleted while the fetch was in flight
        }
        // Merge onto the LATEST committed row (via the ref), not the pre-fetch
        // snapshot, so a user edit made while the fetch ran is preserved. The
        // ref can briefly lag for a just-created bookmark, so fall back to the
        // snapshot it was invoked with.
        const latest = bookmarksRef.current?.find((item) => item.id === bookmark.id) ?? bookmark;
        // Fill only generated fields that are still empty, so a user-authored
        // title is never overwritten by generated metadata.
        const safePatch: Partial<Bookmark> = {};
        if (patch.title !== undefined && latest.title === null) {
          safePatch.title = patch.title;
        }
        if (patch.site_name !== undefined && latest.site_name === null) {
          safePatch.site_name = patch.site_name;
        }
        if (patch.favicon_url !== undefined && latest.favicon_url === null) {
          safePatch.favicon_url = patch.favicon_url;
        }
        if (patch.preview_image_url !== undefined && latest.preview_image_url === null) {
          safePatch.preview_image_url = patch.preview_image_url;
        }
        const updated: Bookmark = {
          ...latest,
          ...safePatch,
          metadata_status,
          updated_at: new Date().toISOString(),
        };

        setBookmarks((current) =>
          current === null
            ? current
            : current.map((item) => (item.id === updated.id ? updated : item)),
        );
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
        } catch (error) {
          logStorageError('metadata enrichment', error);
        }
        // Push the freshly fetched metadata to the cloud so other devices see
        // it on their next pull. Only for already-synced bookmarks: a local
        // bookmark's create upload already sends its latest fields.
        if (hasRemoteIdentity(updated.id)) {
          enqueueMutation(updated.id, 'update');
        }
      } finally {
        enriching.current.delete(bookmark.id);
      }
    })();
  }, [enqueueMutation]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Opening SQLite can fail transiently right after a warm relaunch (the
      // native handle is briefly invalid). Retry a few times before falling
      // back to read-only sample data, so a momentary hiccup doesn't strand the
      // user on the storage-error banner.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await ensureRepositoryReady();
          const [
            storedBookmarks,
            storedQueue,
            storedEnrichments,
            storedTagData,
            storedPulledAt,
            storedTagOpsRaw,
            storedAiTriggerRaw,
            storedReviewedRaw,
            storedUnseenRaw,
          ] = await Promise.all([
            repository.listBookmarks(),
            repository.listQueue(),
            repository.listEnrichments(),
            repository.listTagData(),
            repository.getMeta(LAST_PULLED_AT_KEY),
            repository.getMeta(PENDING_TAG_OPS_KEY),
            repository.getMeta(PENDING_AI_TRIGGER_KEY),
            repository.getMeta(REVIEWED_SUGGESTIONS_KEY),
            repository.getMeta(UNSEEN_SUGGESTIONS_KEY),
          ]);
          if (!cancelled) {
            // Re-hydrate deferred AI triggers so a bookmark whose create synced
            // before the app was killed still gets auto suggestions once its
            // metadata enrichment settles (the effect below picks it up).
            for (const id of parseIdSet(storedAiTriggerRaw)) {
              pendingAiTrigger.current.add(id);
            }
            // Re-hydrate the per-bookmark reviewed-suggestions map so the "✨"
            // badge stays hidden for suggestions the user already acted on.
            const storedReviewed = parseReviewedMap(storedReviewedRaw);
            reviewedSuggestionsRef.current = storedReviewed;
            setReviewedSuggestions(storedReviewed);
            // Re-hydrate the "unseen AI suggestions" set so a suggestion that
            // landed in a session the user never returned to still drives the
            // Inbox banner on this launch.
            const storedUnseen = parseIdSet(storedUnseenRaw);
            unseenSuggestionIdsRef.current = storedUnseen;
            setUnseenSuggestionIds(storedUnseen);
            // Merge instead of replace: saves made while loading must survive.
            setBookmarks((current) =>
              current === null
                ? storedBookmarks
                : mergeById(current, storedBookmarks, (bookmark) => bookmark.id),
            );
            setQueue((current) => mergeById(current, storedQueue, (entry) => entry.local_id));
            // Self-heal stranded bookmarks: a non-synced row whose queue entry
            // never persisted (storage hiccup, or the app killed between the two
            // writes) has nothing to drive its sync and would show "sync
            // pending" forever. Re-enqueue an upload so the background loop
            // finishes it. Idempotent on the server, so it's safe to repeat.
            const orphanEntries = reconcileOrphanedQueueEntries(storedBookmarks, storedQueue);
            if (orphanEntries.length > 0) {
              const orphanIds = new Set(orphanEntries.map((entry) => entry.local_id));
              setQueue((current) => [
                ...current.filter((entry) => !orphanIds.has(entry.local_id)),
                ...orphanEntries,
              ]);
              void Promise.all(orphanEntries.map((entry) => repository.enqueue(entry))).catch(
                (error) => logStorageError('orphan re-enqueue', error),
              );
            }
            setEnrichments(storedEnrichments);
            // One-time cleanup: purge blank-named tags/collections (and orphaned
            // links) a prior version may have stored, so they stop showing as
            // empty Browse chips. Persist the cleaned set back when it changed.
            const { tagData: cleanTagData, changed } = sanitizeTagData(storedTagData);
            if (changed) {
              void repository
                .replaceTagData(cleanTagData)
                .catch((error) => logStorageError('blank-tag cleanup', error));
            }
            // Layer not-yet-synced local tag ops on top of the cached snapshot.
            const storedOps = parseTagOps(storedTagOpsRaw);
            pendingTagOpsRef.current = storedOps;
            setPendingTagOps(storedOps);
            tagDataRef.current = applyPendingTagOps(cleanTagData, storedOps, mockUserId);
            setTagData(tagDataRef.current);
            setLastPulledAt(storedPulledAt);
            setLoadError(false);
          }
          return;
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
            continue;
          }
          logStorageError('startup load', error);
          setLoadError(true);
          setBookmarks((current) =>
            current === null
              ? mockBookmarks
              : mergeById(current, mockBookmarks, (bookmark) => bookmark.id),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadedBookmarks = useMemo(() => bookmarks ?? [], [bookmarks]);

  const getBookmark = useCallback(
    (id: string) => loadedBookmarks.find((bookmark) => bookmark.id === id),
    [loadedBookmarks],
  );

  const getTagsForBookmark = useCallback(
    (id: string) => {
      // Cloud tag links (refreshed by pull sync) win over seeded samples.
      const cloudTagIds = new Set(
        tagData.bookmarkTags.filter((link) => link.bookmark_id === id).map((link) => link.tag_id),
      );
      if (cloudTagIds.size > 0) {
        return tagData.tags.filter((tag) => cloudTagIds.has(tag.id));
      }
      const mockTagIds = mockBookmarkTags
        .filter((link) => link.bookmark_id === id)
        .map((link) => link.tag_id);
      return mockTags.filter((tag) => mockTagIds.includes(tag.id));
    },
    [tagData],
  );

  const getCollection = useCallback(
    (id: string | null) =>
      id === null
        ? undefined
        : (tagData.collections.find((collection) => collection.id === id) ??
          mockCollections.find((collection) => collection.id === id)),
    [tagData],
  );

  const getEnrichment = useCallback(
    (bookmarkId: string) => {
      // Cloud enrichments (refreshed by pull sync) win over seeded samples.
      const cached = enrichments
        .filter((enrichment) => enrichment.bookmark_id === bookmarkId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return (
        cached ?? mockEnrichments.find((enrichment) => enrichment.bookmark_id === bookmarkId)
      );
    },
    [enrichments],
  );

  const addBookmark = useCallback(
    ({
      url,
      title,
      notes,
      shared_text,
      image,
    }: {
      url?: string;
      title?: string;
      notes?: string;
      shared_text?: string;
      image?: SharedImage;
    }): AddBookmarkResult => {
      // A shared image becomes an image bookmark: capture is local-first and
      // local-only for now (cloud upload of the binary is deferred to 0.3.x), so
      // it is never enqueued for sync. We mark it 'synced' precisely because
      // there is no cloud work pending — that also keeps the startup orphan
      // reconciler from re-enqueuing it and the Inbox/Detail from showing a
      // misleading "sync pending" chip. Capture is sacred: the durable file copy
      // is folded into `persisted` so the share handler only dismisses once it
      // has actually landed on disk.
      if (image) {
        const now = new Date().toISOString();
        const id = makeLocalId();
        const fileName = localImageFileName(id, image);
        const imageBookmark: Bookmark = {
          id,
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          // A title typed at capture is user-authored; otherwise derive a
          // readable one from the shared filename (may be null → "Untitled").
          title: title?.trim() ? title.trim() : imageTitleFromFileName(image.fileName),
          description: null,
          notes: notes?.trim() ? notes.trim() : null,
          source_app: null,
          content_type: 'image',
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          last_saved_at: now,
          // No URL/text to derive metadata from — nothing to enrich.
          metadata_status: 'skipped',
          sync_status: 'synced',
          // Temporary share URI for the optimistic render; swapped for the
          // durable copy once `copyImageToLibrary` resolves below.
          local_image_uri: image.uri,
        };

        setBookmarks((current) => [imageBookmark, ...(current ?? [])]);
        const persisted = ensureRepositoryReady()
          .then(() => copyImageToLibrary(image.uri, fileName))
          .then((durableUri) => {
            const stored: Bookmark = { ...imageBookmark, local_image_uri: durableUri };
            setBookmarks((current) =>
              current === null ? current : current.map((b) => (b.id === id ? stored : b)),
            );
            return repository.insertBookmark(stored);
          })
          .then(() => true)
          .catch((error) => {
            logStorageError('new image bookmark', error);
            return false;
          });

        return { status: 'created', bookmark: imageBookmark, persisted };
      }

      const normalized = url ? normalizeUrl(url) : null;
      if (!normalized) {
        // No usable URL. If the share carried text (e.g. a KakaoTalk message
        // with no link), save it as a text note rather than dropping deliberately
        // shared content — capture is sacred. Reject only when there is nothing
        // at all to save.
        const text = shared_text?.trim() || null;
        if (!text) {
          return {
            status: 'invalid',
            error: 'Enter a valid web address, like example.com or https://example.com.',
          };
        }

        const noteNow = new Date().toISOString();
        // Text notes have no canonical URL key, so distinct shares are distinct
        // notes by design. The client_id below is NOT a content key: it's this
        // capture's stable id, resent on every retry so an interrupted upload
        // dedupes against its own first attempt instead of inserting a twin.
        const noteClientId = makeClientId();
        const note: Bookmark = {
          id: makeLocalId(),
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: noteClientId,
          title: title?.trim() ? title.trim() : null,
          // The shared text is the note's body. Stored as the description to
          // mirror the cloud API (which maps shared_text → description), so a
          // pulled-back note matches the locally captured one.
          description: text,
          notes: notes?.trim() ? notes.trim() : null,
          source_app: null,
          content_type: 'text',
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: noteNow,
          updated_at: noteNow,
          last_saved_at: noteNow,
          metadata_status: 'pending',
          sync_status: 'pending',
        };

        const noteEntry: LocalPendingBookmark = {
          local_id: note.id,
          remote_id: null,
          operation: 'create',
          payload: {
            title: note.title ?? undefined,
            notes: note.notes ?? undefined,
            shared_text: text,
            client_id: noteClientId,
          },
          sync_status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: noteNow,
          updated_at: noteNow,
        };

        setBookmarks((current) => [note, ...(current ?? [])]);
        setQueue((current) => [...current, noteEntry]);
        const persisted = ensureRepositoryReady()
          .then(() =>
            Promise.all([repository.insertBookmark(note), repository.enqueue(noteEntry)]),
          )
          .then(() => true)
          .catch((error) => {
            logStorageError('new text note', error);
            return false;
          });

        // No URL to derive metadata from; this transitions metadata_status to
        // 'skipped' via the existing, tested enrichment path.
        enrichInBackground(note);

        return { status: 'created', bookmark: note, persisted };
      }

      const now = new Date().toISOString();

      // Idempotent saves: reuse the existing bookmark for the same URL. Dedupe
      // on the canonical form so tracking params / fragments don't create dupes.
      const dedupeKey = canonicalizeUrl(normalized);
      const existing = loadedBookmarks.find((bookmark) => currentDedupeKey(bookmark) === dedupeKey);
      if (existing) {
        const updated = { ...existing, last_saved_at: now };
        setBookmarks((current) =>
          (current ?? []).map((bookmark) => (bookmark.id === existing.id ? updated : bookmark)),
        );
        const persisted = ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .then(() => true)
          .catch((error) => {
            logStorageError('duplicate save', error);
            return false;
          });
        return { status: 'duplicate', bookmark: existing, persisted };
      }

      const clientId = makeClientId();
      const bookmark: Bookmark = {
        id: makeLocalId(),
        user_id: mockUserId,
        url: normalized,
        canonical_url: null,
        // Canonical dedupe key (tracking params/fragment stripped). canonical_url
        // stays null until enrichment resolves a real rel=canonical / og:url.
        url_hash: dedupeKey,
        client_id: clientId,
        // A title provided at capture (e.g. from the share payload) counts as
        // user-authored; enrichment only fills it when still null.
        title: title?.trim() ? title.trim() : null,
        description: null,
        notes: notes?.trim() ? notes.trim() : null,
        source_app: null,
        content_type: 'url',
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: 'pending',
        sync_status: 'pending',
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        operation: 'create',
        payload: {
          url: normalized,
          title: bookmark.title ?? undefined,
          notes: bookmark.notes ?? undefined,
          client_id: clientId,
        },
        sync_status: 'pending',
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      };

      // Optimistic update first; persistence happens in the background so
      // capture never waits on storage or (later) the network.
      setBookmarks((current) => [bookmark, ...(current ?? [])]);
      setQueue((current) => [...current, queueEntry]);
      const persisted = ensureRepositoryReady()
        .then(() =>
          Promise.all([repository.insertBookmark(bookmark), repository.enqueue(queueEntry)]),
        )
        .then(() => true)
        .catch((error) => {
          logStorageError('new bookmark', error);
          return false;
        });

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: 'created', bookmark, persisted };
    },
    [loadedBookmarks, enrichInBackground],
  );

  // Bulk re-ingest of imported items. Mirrors addBookmark's local-first create
  // (optimistic insert + queued create + background enrichment) but batches the
  // whole file into one state update, and dedupes within the batch too so a file
  // listing the same URL twice doesn't create duplicates.
  const importBookmarks = useCallback(
    (items: ImportItem[]): ImportSummary => {
      const now = new Date().toISOString();
      // Latest committed rows (the ref), so an import right after a save sees it.
      const seen = new Set(
        (bookmarksRef.current ?? loadedBookmarks)
          .map((bookmark) => currentDedupeKey(bookmark))
          .filter((hash): hash is string => hash !== null),
      );
      const newBookmarks: Bookmark[] = [];
      const newEntries: LocalPendingBookmark[] = [];
      let imported = 0;
      let duplicates = 0;
      let skipped = 0;

      for (const item of items) {
        const normalized = item.url ? normalizeUrl(item.url) : null;
        if (!normalized) {
          skipped += 1;
          continue;
        }
        const dedupeKey = canonicalizeUrl(normalized);
        if (seen.has(dedupeKey)) {
          duplicates += 1;
          continue;
        }
        seen.add(dedupeKey);

        const id = makeLocalId();
        const title = item.title?.trim() ? item.title.trim() : null;
        const notes = item.notes?.trim() ? item.notes.trim() : null;
        newBookmarks.push({
          id,
          user_id: mockUserId,
          url: normalized,
          canonical_url: null,
          url_hash: dedupeKey,
          title,
          description: null,
          notes,
          source_app: null,
          content_type: 'url',
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          last_saved_at: now,
          metadata_status: 'pending',
          sync_status: 'pending',
        });
        newEntries.push({
          local_id: id,
          remote_id: null,
          operation: 'create',
          payload: { url: normalized, title: title ?? undefined, notes: notes ?? undefined },
          sync_status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        });
        imported += 1;
      }

      if (newBookmarks.length > 0) {
        setBookmarks((current) => [...newBookmarks, ...(current ?? [])]);
        setQueue((current) => [...current, ...newEntries]);
        ensureRepositoryReady()
          .then(() =>
            Promise.all([
              ...newBookmarks.map((bookmark) => repository.insertBookmark(bookmark)),
              ...newEntries.map((entry) => repository.enqueue(entry)),
            ]),
          )
          .catch((error) => logStorageError('imported bookmarks', error));
        // Enrich after the rows are visible and persisted, like a fresh save.
        for (const bookmark of newBookmarks) {
          enrichInBackground(bookmark);
        }
      }

      return { imported, duplicates, skipped };
    },
    [loadedBookmarks, enrichInBackground],
  );

  // Local-first edit of user-editable fields: apply + persist immediately,
  // show as sync-pending, and queue an update mutation for synced bookmarks.
  const applyBookmarkUpdate = useCallback(
    (id: string, patch: Partial<Bookmark>) => {
      const syncsRemotely = hasRemoteIdentity(id);
      let updated: Bookmark | null = null;
      setBookmarks((current) => {
        if (current === null) {
          return current;
        }
        return current.map((bookmark) => {
          if (bookmark.id !== id) {
            return bookmark;
          }
          updated = {
            ...bookmark,
            ...patch,
            sync_status: syncsRemotely ? 'pending' : bookmark.sync_status,
            updated_at: new Date().toISOString(),
          };
          return updated;
        });
      });
      if (updated) {
        ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated as Bookmark))
          .catch((error) => logStorageError('bookmark update', error));
        if (syncsRemotely) {
          enqueueMutation(id, 'update');
        }
      }
    },
    [enqueueMutation],
  );

  const trashBookmark = useCallback(
    (id: string) => applyBookmarkUpdate(id, { deleted_at: new Date().toISOString() }),
    [applyBookmarkUpdate],
  );

  const restoreBookmark = useCallback(
    (id: string) => applyBookmarkUpdate(id, { deleted_at: null }),
    [applyBookmarkUpdate],
  );

  // Mark a bookmark's newest 'complete' enrichment as stale when the user edits
  // its title/notes, so Bookmark Detail can flag the suggestions as out of date
  // until "Refresh AI suggestions" regenerates them. Local-first: never calls
  // the network here, just updates + persists the status.
  const markEnrichmentStale = useCallback((bookmarkId: string) => {
    const current = enrichmentsRef.current
      .filter((enrichment) => enrichment.bookmark_id === bookmarkId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!current || current.status !== 'complete') {
      return;
    }
    const stale: AIEnrichment = { ...current, status: 'stale', updated_at: new Date().toISOString() };
    setEnrichments((rows) => rows.map((row) => (row.id === stale.id ? stale : row)));
    ensureRepositoryReady()
      .then(() => repository.upsertEnrichments([stale]))
      .catch((error) => logStorageError('enrichment staleness', error));
  }, []);

  const updateBookmarkFields = useCallback(
    (id: string, fields: { title?: string; notes?: string }) => {
      const before = bookmarksRef.current?.find((bookmark) => bookmark.id === id);
      const patch: Partial<Bookmark> = {};
      if (fields.title !== undefined) {
        patch.title = fields.title.trim() || null;
      }
      if (fields.notes !== undefined) {
        patch.notes = fields.notes.trim() || null;
      }
      // Only stale on a real change to user-editable text; a no-op save (or a
      // collection/archive change, which never routes through here) must not.
      const textChanged =
        (patch.title !== undefined && patch.title !== (before?.title ?? null)) ||
        (patch.notes !== undefined && patch.notes !== (before?.notes ?? null));
      applyBookmarkUpdate(id, patch);
      if (textChanged) {
        markEnrichmentStale(id);
      }
    },
    [applyBookmarkUpdate, markEnrichmentStale],
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      deletedIds.current.add(id);
      setBookmarks((current) => (current === null ? current : current.filter((b) => b.id !== id)));
      if (hasRemoteIdentity(id)) {
        // The row exists remotely: replace any queued work with a durable
        // delete mutation so the removal reaches Supabase even after restart.
        ensureRepositoryReady()
          .then(() => repository.deleteBookmark(id))
          .catch((error) => logStorageError('delete bookmark', error));
        enqueueMutation(id, 'delete');
        return;
      }
      // Local-only: drop any pending queue entry so it is never created remotely.
      setQueue((current) => current.filter((entry) => entry.local_id !== id));
      ensureRepositoryReady()
        .then(() => Promise.all([repository.deleteBookmark(id), repository.removeQueueEntry(id)]))
        .catch((error) => logStorageError('delete bookmark', error));
    },
    [enqueueMutation],
  );

  const emptyTrash = useCallback(() => {
    const trashed = (bookmarksRef.current ?? []).filter((b) => b.deleted_at !== null);
    for (const bookmark of trashed) {
      deleteBookmark(bookmark.id);
    }
  }, [deleteBookmark]);

  // Push queued tag ops to the server when online: ensure tags exist, reconcile
  // the optimistic local tag id to the server one, and drop the op on success.
  // Failures stay queued for the next sync.
  const syncTagOps = useCallback(async () => {
    if (!auth.session) {
      return;
    }
    const ops = pendingTagOpsRef.current;
    if (ops.length === 0) {
      return;
    }
    const api = createSyncApi(auth.session);
    for (const op of ops) {
      // The bookmark must exist remotely before its tags can be linked.
      if (!hasRemoteIdentity(op.bookmark_id)) {
        continue;
      }
      try {
        if (op.op === 'add') {
          const ensured = await api.addTags({
            bookmark_id: op.bookmark_id,
            tags: [op.tag_name],
            source: op.source,
          });
          const serverTag =
            ensured.find((tag) => normalizeTag(tag.name) === normalizeTag(op.tag_name)) ??
            ensured[0];
          if (serverTag) {
            applyTagData(reconcileSyncedAdd(tagDataRef.current, op.tag_name, serverTag));
          }
        } else {
          await api.removeTags({ bookmark_id: op.bookmark_id, tags: [op.tag_name] });
        }
        applyTagOps(dequeueTagOp(pendingTagOpsRef.current, op.bookmark_id, op.tag_name));
      } catch (error) {
        // Keep the op queued; the next sync retries it.
        recordLog('warn', `tag sync failed (${op.op} ${op.tag_name}): ${String(error)}`);
      }
    }
  }, [auth.session, applyTagData, applyTagOps]);

  // Local-first: apply the tag immediately and queue the upload. Works offline
  // and the moment a bookmark has synced; the queued op uploads on the next sync.
  const addTagsToBookmark = useCallback(
    async (bookmarkId: string, names: string[]): Promise<string | null> => {
      if (!hasRemoteIdentity(bookmarkId)) {
        return 'Tags can be added once this bookmark has synced.';
      }
      const cleaned = names.map((name) => name.trim()).filter((name) => name.length > 0);
      if (cleaned.length === 0) {
        return 'Enter a tag name.';
      }
      const userId = auth.userId ?? mockUserId;
      const now = new Date().toISOString();
      let nextData = tagDataRef.current;
      let nextOps = pendingTagOpsRef.current;
      for (const name of cleaned) {
        const op: PendingTagOp = {
          id: makeLocalId(),
          bookmark_id: bookmarkId,
          tag_name: name,
          op: 'add',
          source: 'user',
          confidence: null,
          created_at: now,
        };
        nextData = applyTagOp(nextData, op, userId);
        nextOps = enqueueTagOp(nextOps, op);
      }
      applyTagData(nextData);
      applyTagOps(nextOps);
      void syncTagOps();
      return null;
    },
    [auth.userId, applyTagData, applyTagOps, syncTagOps],
  );

  const removeTagFromBookmark = useCallback(
    async (bookmarkId: string, tagName: string): Promise<string | null> => {
      if (!hasRemoteIdentity(bookmarkId)) {
        return 'Seeded sample tags cannot be edited.';
      }
      const op: PendingTagOp = {
        id: makeLocalId(),
        bookmark_id: bookmarkId,
        tag_name: tagName,
        op: 'remove',
        source: 'user',
        confidence: null,
        created_at: new Date().toISOString(),
      };
      applyTagData(applyTagOp(tagDataRef.current, op, auth.userId ?? mockUserId));
      applyTagOps(enqueueTagOp(pendingTagOpsRef.current, op));
      void syncTagOps();
      return null;
    },
    [auth.userId, applyTagData, applyTagOps, syncTagOps],
  );

  // Ask the backend to (re)generate AI suggestions for a synced bookmark. The
  // edge function writes the enrichment and returns it, so we surface results
  // immediately rather than waiting for the next pull. Fire-and-forget safe:
  // failures (e.g. the function isn't deployed yet) just return a message.
  const requestAiEnrichment = useCallback(
    async (bookmarkId: string, source: 'auto' | 'manual' = 'manual'): Promise<string | null> => {
      if (!auth.session) {
        return 'AI suggestions need the cloud — Supabase is not available right now.';
      }
      if (!hasRemoteIdentity(bookmarkId)) {
        return 'AI suggestions are available once this bookmark has synced.';
      }
      if (aiEnriching.current.has(bookmarkId)) {
        return null;
      }
      aiEnriching.current.add(bookmarkId);
      setEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      if (source === 'manual') {
        setManualEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      }
      try {
        // The edge function forwards this access token to PostgREST, which 401s
        // on a stale one. The token can expire while the app sits idle, so
        // refresh it before the call (as the sync paths do) instead of reusing
        // the possibly-expired `auth.session`.
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
        if (!session) {
          return 'AI suggestions need the cloud — Supabase is not available right now.';
        }
        // Send the device's freshest metadata: the cloud row can still be a bare
        // URL (on-device OpenGraph enrichment may not have synced yet), and the
        // model would otherwise have nothing to reason about.
        const latest = bookmarksRef.current?.find((item) => item.id === bookmarkId);
        const metadata: EnrichmentMetadataHint | undefined = latest
          ? {
              title: latest.title,
              description: latest.description,
              notes: latest.notes,
              site_name: latest.site_name,
              content_type: latest.content_type,
            }
          : undefined;
        const activeLocale = localeRef.current;
        let enrichment: AIEnrichment;
        try {
          enrichment = await createSyncApi(session).requestEnrichment(
            bookmarkId,
            metadata,
            activeLocale,
          );
        } catch (error) {
          // If the server still rejects the token (rotation / clock skew),
          // force a refresh and retry once before surfacing the error.
          if (error instanceof SupabaseRequestError && error.status === 401) {
            const refreshed = (await auth.ensureAnonymousSession(true)) ?? session;
            enrichment = await createSyncApi(refreshed).requestEnrichment(
              bookmarkId,
              metadata,
              activeLocale,
            );
          } else {
            throw error;
          }
        }
        // Newest enrichment for this bookmark wins (getEnrichment sorts too).
        setEnrichments((current) => [
          enrichment,
          ...current.filter((item) => item.bookmark_id !== bookmarkId),
        ]);
        // A background auto-enrichment lands without the user looking at this
        // bookmark, so flag it for the Inbox "new suggestions" banner. A manual
        // "Suggest with AI" tap happens on the Detail screen — the user is
        // already witnessing it — so it doesn't (and Detail clears the flag).
        if (source === 'auto') {
          noteUnseenSuggestions(enrichment);
        }
        try {
          await ensureRepositoryReady();
          await repository.upsertEnrichments([enrichment]);
        } catch (error) {
          logStorageError('ai enrichment', error);
        }
        return null;
      } catch (error) {
        // Rate limited (429): expected when many bookmarks are captured at once.
        // Return a sentinel the Detail screen localizes into a calm message; the
        // deferred auto-trigger ignores this value and keeps its durable marker,
        // so it retries on a later launch (and won't retry-storm this session).
        if (error instanceof SupabaseRequestError && error.status === 429) {
          return AI_RATE_LIMITED;
        }
        // Anything else is a genuine failure the user can't act on (e.g. the
        // ai-enrich edge function returning 400/500). It was only ever surfaced
        // in the Detail UI; record it so it also lands in the in-app diagnostics
        // buffer and reaches Sentry (URL/email-scrubbed at the bridge), the way
        // preview-fetch failures already do — otherwise an outage is invisible.
        const detail = error instanceof Error ? error.message : String(error);
        const status = error instanceof SupabaseRequestError ? ` (HTTP ${error.status})` : '';
        recordLog('error', `ai-enrich failed${status}: ${detail}`);
        return error instanceof Error ? error.message : 'Could not generate AI suggestions.';
      } finally {
        aiEnriching.current.delete(bookmarkId);
        const remove = (prev: ReadonlySet<string>): ReadonlySet<string> => {
          if (!prev.has(bookmarkId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(bookmarkId);
          return next;
        };
        setEnrichingIds(remove);
        if (source === 'manual') {
          setManualEnrichingIds(remove);
        }
      }
    },
    [auth, noteUnseenSuggestions],
  );

  // True while an AI enrichment request for this bookmark is in flight (whether
  // auto-triggered after sync or started by a manual "Suggest with AI" tap).
  const isEnriching = useCallback(
    (bookmarkId: string): boolean => enrichingIds.has(bookmarkId),
    [enrichingIds],
  );

  // True only for a user-initiated request, so the button can show explicit
  // feedback without the auto-trigger ever making the section feel like a wait.
  const isManuallyEnriching = useCallback(
    (bookmarkId: string): boolean => manualEnrichingIds.has(bookmarkId),
    [manualEnrichingIds],
  );

  // Accept AI-suggested tags: ensure + link them with `source: 'ai'` so their
  // provenance and confidence are preserved (vs. user-typed tags).
  const acceptSuggestedTags = useCallback(
    async (bookmarkId: string, suggestions: SuggestedTag[]): Promise<string | null> => {
      if (!hasRemoteIdentity(bookmarkId)) {
        return 'Tags can be added once this bookmark has synced.';
      }
      const valid = suggestions.filter((suggestion) => suggestion.name.trim().length > 0);
      if (valid.length === 0) {
        return null;
      }
      const userId = auth.userId ?? mockUserId;
      const now = new Date().toISOString();
      let nextData = tagDataRef.current;
      let nextOps = pendingTagOpsRef.current;
      for (const suggestion of valid) {
        const op: PendingTagOp = {
          id: makeLocalId(),
          bookmark_id: bookmarkId,
          tag_name: suggestion.name,
          op: 'add',
          source: 'ai',
          confidence: suggestion.confidence,
          created_at: now,
        };
        nextData = applyTagOp(nextData, op, userId);
        nextOps = enqueueTagOp(nextOps, op);
      }
      applyTagData(nextData);
      applyTagOps(nextOps);
      // Accepting a suggestion counts as reviewing it, so removing the tag later
      // won't bring the "✨" badge back for a name the user already decided on.
      markSuggestionsReviewed(
        bookmarkId,
        valid.map((suggestion) => suggestion.name),
      );
      void syncTagOps();
      return null;
    },
    [auth.userId, applyTagData, applyTagOps, markSuggestionsReviewed, syncTagOps],
  );

  const assignCollection = useCallback(
    (bookmarkId: string, collectionId: string | null) =>
      applyBookmarkUpdate(bookmarkId, { collection_id: collectionId }),
    [applyBookmarkUpdate],
  );

  const createCollection = useCallback(
    async (name: string): Promise<{ collection?: Collection; error?: string }> => {
      if (!auth.session) {
        return { error: 'Collections need the cloud — Supabase is not available right now.' };
      }
      if (!name.trim()) {
        return { error: 'Enter a collection name.' };
      }
      try {
        const api = createSyncApi(auth.session);
        const created = await api.createCollection(name);
        const current = tagDataRef.current;
        applyTagData({ ...current, collections: [...current.collections, created] });
        return { collection: created };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Could not create the collection.',
        };
      }
    },
    [auth, applyTagData],
  );

  const syncNow = useCallback(async () => {
    if (syncInFlight.current) {
      return;
    }
    if (!auth.session) {
      return;
    }
    // Upload-then-pull: even with nothing to upload, the pull still runs.
    const syncable = queue.filter(isSyncable);

    syncInFlight.current = true;
    setIsSyncing(true);
    try {
      await ensureRepositoryReady();
      // Drain terminal 'synced' leftovers a prior run persisted but never
      // removed, so they don't linger forever in the visible queue. A create
      // marks its queue row 'synced' (with the new remote_id) BEFORE swapping
      // the local bookmark from its local-* id to that remote id; if the app
      // was killed between those two writes, the local row is still under the
      // old id. Finish that swap before dropping the row — otherwise the only
      // record of the remote id is deleted and the local-* bookmark is stranded
      // as a permanent duplicate of the remote row once the pull brings it down.
      const syncedLeftovers = queue.filter((entry) => entry.sync_status === 'synced');
      if (syncedLeftovers.length > 0) {
        const swaps = planLeftoverReconciliation(syncedLeftovers, bookmarksRef.current ?? []);
        for (const { localId, reconciled } of swaps) {
          setBookmarks((current) =>
            (current ?? []).map((bookmark) => (bookmark.id === localId ? reconciled : bookmark)),
          );
          void repository
            .replaceBookmark(localId, reconciled)
            .catch((error) => logStorageError('synced leftover reconcile', error));
        }
        setQueue((current) => current.filter((entry) => entry.sync_status !== 'synced'));
        void Promise.all(
          syncedLeftovers.map((entry) => repository.removeQueueEntry(entry.local_id)),
        ).catch((error) => logStorageError('synced leftover cleanup', error));
      }
      // Re-ensure the session so a token that expired while the app stayed
      // open is refreshed before we sync; otherwise every entry would fail
      // against a stale bearer token until restart.
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      const api = createSyncApi(session);
      const getLatestBookmark = (id: string) =>
        bookmarksRef.current?.find((bookmark) => bookmark.id === id);

      for (const entry of syncable) {
        // Deleted while this run was queued up: skip creates/updates for it.
        // Delete entries are exactly how that deletion reaches the server,
        // so they must still run.
        if (entry.operation !== 'delete' && deletedIds.current.has(entry.local_id)) {
          continue;
        }

        // A storage/repository failure on one entry must not abort the whole
        // run and strand this (and every later) entry at 'syncing' forever.
        // Mark just this entry failed so the next pass retries it.
        try {
          setQueue((current) =>
            current.map((queued) =>
              queued.local_id === entry.local_id ? { ...queued, sync_status: 'syncing' } : queued,
            ),
          );

          const result = await syncQueueEntry(api, repository, entry, getLatestBookmark);

          // Deleted while a create/update was in flight: don't resurrect it.
          // Undo the rows syncQueueEntry just persisted and best-effort delete
          // the remote copy so the user's delete wins end to end.
          if (entry.operation !== 'delete' && deletedIds.current.has(entry.local_id)) {
            const replacementId = result.bookmarkReplacement?.bookmark.id;
            ensureRepositoryReady()
              .then(() =>
                Promise.all([
                  replacementId ? repository.deleteBookmark(replacementId) : Promise.resolve(),
                  // Superseded-aware: a durable delete entry enqueued for this
                  // bookmark while we were uploading must NOT be removed here.
                  removeQueueEntryIfNotSuperseded(repository, entry),
                ]),
              )
              .catch((error) => logStorageError('post-delete sync cleanup', error));
            if (result.entry.remote_id && result.entry.remote_id !== entry.local_id) {
              // The upload created a remote row for a bookmark the user already
              // deleted. Enqueue a durable delete (not a best-effort request) so
              // the removal survives app exit and request failures; the next
              // sync pass processes it.
              enqueueMutation(result.entry.remote_id, 'delete');
            }
            continue;
          }

          setQueue((current) =>
            result.removeEntry
              ? current.filter((queued) => queued.local_id !== entry.local_id)
              : current.map((queued) =>
                  queued.local_id === entry.local_id ? result.entry : queued,
                ),
          );
          if (result.bookmarkReplacement) {
            const { previousId, bookmark: replacement } = result.bookmarkReplacement;
            // The replacement was built from a snapshot taken before the upload.
            // Enrichment may have completed in the meantime, so apply only the
            // sync-owned fields (identity + status) onto the LATEST row instead
            // of writing the stale snapshot back.
            //
            // Compute `merged` from the ref SYNCHRONOUSLY — never from inside the
            // setBookmarks updater. A functional updater doesn't run until React's
            // next render, so reading a variable it assigns right after the call
            // sees the pre-update value (null). That silently skipped this whole
            // block, so neither the metadata-reconciliation update nor the AI
            // auto-trigger ever fired after a create synced.
            const latest = bookmarksRef.current?.find((bookmark) => bookmark.id === previousId);
            const merged: Bookmark | null = latest
              ? {
                  ...latest,
                  id: replacement.id,
                  sync_status: replacement.sync_status,
                  updated_at: replacement.updated_at,
                }
              : null;
            if (merged) {
              setBookmarks((current) =>
                (current ?? []).map((bookmark) =>
                  bookmark.id === previousId ? merged : bookmark,
                ),
              );
              // replaceBookmark (not update) so a concurrent enrichment persist
              // that resurrected the old local-ID row gets cleaned up too.
              const persisted: Bookmark = merged;
              ensureRepositoryReady()
                .then(() => repository.replaceBookmark(previousId, persisted))
                .catch((error) => logStorageError('post-sync merge', error));
              // The create payload only carries url/title/notes, and the remote
              // row defaults to no generated metadata + pending status. If the
              // local row has since diverged — archived, filed into a collection,
              // edited, or enriched while the create was uploading — reconcile
              // with a follow-up update so those changes reach the cloud.
              if (
                entry.operation === 'create' &&
                (persisted.is_archived ||
                  persisted.collection_id !== null ||
                  persisted.title !== (result.uploadedPayload?.title ?? null) ||
                  persisted.notes !== (result.uploadedPayload?.notes ?? null) ||
                  persisted.metadata_status !== 'pending' ||
                  persisted.site_name !== null ||
                  persisted.favicon_url !== null ||
                  persisted.preview_image_url !== null)
              ) {
                enqueueMutation(persisted.id, 'update');
              }
              // A brand-new bookmark just gained a remote identity: queue AI
              // suggestions for it. We DON'T fire immediately — the background
              // OpenGraph fetch may still be in flight, and enriching against a
              // bare URL yields nothing. The effect below fires once this
              // bookmark's metadata enrichment has settled.
              if (entry.operation === 'create') {
                markPendingAiTrigger(persisted.id);
              }
            }
          }
        } catch (error) {
          logStorageError('sync entry', error);
          const failed: LocalPendingBookmark = {
            ...entry,
            sync_status: 'failed',
            retry_count: entry.retry_count + 1,
            last_error: error instanceof Error ? error.message : 'Sync failed.',
            updated_at: new Date().toISOString(),
          };
          setQueue((current) =>
            current.map((queued) => (queued.local_id === entry.local_id ? failed : queued)),
          );
          ensureRepositoryReady()
            .then(() => repository.updateQueueEntry(failed))
            .catch((persistError) => logStorageError('sync entry fail-persist', persistError));
        }
      }

      const currentUser = {
        id: session.user.id,
        isAnonymous: session.user.is_anonymous !== false,
      };

      // Account-switch guard: before pulling, reconcile the local cache with the
      // signed-in user so a pull can never treat another account's rows as
      // remote deletions. Anonymous data carries over (re-home); a different
      // real account's cache is dropped (it stays safe in that account's cloud).
      try {
        const previousUserId = await repository.getMeta(SYNCED_USER_ID_KEY);
        const previousAnon = (await repository.getMeta(SYNCED_USER_ANON_KEY)) === 'true';
        const plan = planAccountTransition(
          previousUserId ? { id: previousUserId, isAnonymous: previousAnon } : null,
          currentUser,
          bookmarksRef.current ?? [],
        );
        await applyAccountTransition(
          plan,
          repository,
          setBookmarks,
          setQueue,
          makeLocalId,
          ensureRepositoryReady,
        );
      } catch (error) {
        logStorageError('account transition', error);
      }

      // Upload any queued local-first tag ops before pulling, so the pull's
      // server snapshot already reflects them.
      await syncTagOps();

      // Pull phase: bring down remote changes (other devices, cloud AI
      // enrichment). Local rows with queued work are never overwritten.
      try {
        const result = await pullRemoteChanges(
          api,
          repository,
          () => bookmarksRef.current ?? [],
          (bookmarkId) =>
            deletedIds.current.has(bookmarkId) ||
            queueRef.current.some(
              (queued) => queued.local_id === bookmarkId && queued.sync_status !== 'synced',
            ),
          currentUser,
        );
        if (result.upserts.length > 0 || result.deletions.length > 0) {
          const upsertIds = new Set(result.upserts.map((bookmark) => bookmark.id));
          const removed = new Set(result.deletions);
          setBookmarks((current) => [
            ...(current ?? []).filter(
              (bookmark) => !upsertIds.has(bookmark.id) && !removed.has(bookmark.id),
            ),
            ...result.upserts,
          ]);
        }
        if (result.enrichments.length > 0) {
          // Flag enrichments that arrived unwitnessed (a server-side trigger's
          // result, or another device's) for the Inbox banner. Flag a row when
          // it's brand new OR a genuine update — the edge function upserts on
          // `bookmark_id` and keeps the same enrichment id, so a re-enrichment
          // from another device reuses the id; gating on id novelty alone would
          // miss those changed suggestions. Compare `updated_at` so a true update
          // flags while the pull's watermark-overlap re-fetch of an *unchanged*
          // row (same timestamp) doesn't re-surface a suggestion already seen.
          const knownById = new Map(
            enrichmentsRef.current.map((enrichment) => [enrichment.id, enrichment] as const),
          );
          for (const enrichment of result.enrichments) {
            const known = knownById.get(enrichment.id);
            if (!known || enrichment.updated_at > known.updated_at) {
              noteUnseenSuggestions(enrichment);
            }
          }
          setEnrichments((current) =>
            mergeById(
              result.enrichments,
              current,
              (enrichment) => enrichment.id,
            ),
          );
        }
        // Re-layer any still-unsynced local tag ops over the fresh server
        // snapshot so optimistic tags aren't dropped by the wholesale replace.
        const mergedTagData = applyPendingTagOps(
          result.tagData,
          pendingTagOpsRef.current,
          auth.userId ?? mockUserId,
        );
        tagDataRef.current = mergedTagData;
        setTagData(mergedTagData);
        setLastPulledAt(result.pulledAt);
      } catch (error) {
        logStorageError('pull', error);
      }
    } catch (error) {
      logStorageError('sync run', error);
    } finally {
      syncInFlight.current = false;
      setIsSyncing(false);
    }
  }, [auth, queue, enqueueMutation, requestAiEnrichment, syncTagOps, noteUnseenSuggestions]);

  // Background enrichment: once local data is loaded, enrich any bookmark
  // whose metadata is still pending (seeded items, or saves from a previous
  // session that closed before enrichment finished).
  useEffect(() => {
    if (bookmarks === null) {
      return;
    }
    for (const bookmark of bookmarks) {
      if (bookmark.metadata_status === 'pending') {
        enrichInBackground(bookmark);
      }
    }
  }, [bookmarks, enrichInBackground]);

  // Deferred auto AI enrichment: fire for a freshly created bookmark only once
  // its metadata enrichment has settled (no longer 'pending'), so the model
  // sees a real title/site instead of the bare URL it was captured as. Driven
  // off committed state, so it's correct whether the create or the OpenGraph
  // fetch finished first, and immune to any local→remote id swap along the way.
  useEffect(() => {
    // Wait for an auth session: requestAiEnrichment no-ops without one, and
    // marking the id attempted before then would consume the only same-session
    // attempt — when auth restores, the rerun would skip it and the trigger
    // would never fire until another restart. On a cold start, storage loads
    // before the session is restored, so this gate matters.
    if (bookmarks === null || !auth.session || pendingAiTrigger.current.size === 0) {
      return;
    }
    for (const id of [...pendingAiTrigger.current]) {
      if (aiTriggerAttempted.current.has(id)) {
        continue; // already fired this session — don't re-fire on every render
      }
      const bookmark = bookmarks.find((item) => item.id === id);
      if (!bookmark) {
        continue; // not committed under this id yet — wait for a later render
      }
      if (bookmark.metadata_status === 'pending') {
        continue; // metadata fetch still in flight — fire once it settles
      }
      // Already has suggestions (enriched in a prior session or via the manual
      // action): clear the durable marker without re-requesting.
      if (enrichmentsRef.current.some((enrichment) => enrichment.bookmark_id === id)) {
        clearPendingAiTrigger(id);
        continue;
      }
      aiTriggerAttempted.current.add(id);
      // Clear the durable marker only on success; a failure keeps it so the
      // next launch retries (the in-memory attempt guard prevents a same-session
      // retry storm).
      void requestAiEnrichment(id, 'auto').then((error) => {
        if (!error) {
          clearPendingAiTrigger(id);
        }
      });
    }
  }, [bookmarks, auth.session, requestAiEnrichment, clearPendingAiTrigger]);

  // Background sync: upload as soon as auth and local data are ready, and
  // whenever a new pending entry appears. Failed entries are retried on the
  // next save or via the manual Sync now action, not in a hot loop.
  useEffect(() => {
    if (
      !isSyncing &&
      bookmarks !== null &&
      (auth.status === 'anonymous' || auth.status === 'authenticated') &&
      // 'syncing' is included so an entry an interrupted run stranded in-flight
      // is re-driven automatically; failed entries wait for a save / Sync now.
      queue.some(
        (entry) => entry.sync_status === 'pending' || entry.sync_status === 'syncing',
      )
    ) {
      void syncNow();
    }
  }, [bookmarks, auth.status, queue, isSyncing, syncNow]);

  // Pull on first ready, and again whenever the signed-in user changes —
  // including the anonymous → real upgrade at sign-in and an account switch.
  // Runs even with an empty queue so remote changes (other devices, cloud AI
  // enrichment) reach this device. Keying off the user id (not a one-shot flag)
  // is what makes a sign-in pull the account's existing cloud data right away:
  // the startup pass already fired for the auto-created anonymous user, and the
  // background-sync effect only fires when there is queued work — so without
  // this, a reinstall-then-sign-in would show an empty library until the next
  // cold start.
  useEffect(() => {
    if (
      !isSyncing &&
      bookmarks !== null &&
      auth.userId !== null &&
      (auth.status === 'anonymous' || auth.status === 'authenticated') &&
      lastSyncedUserId.current !== auth.userId
    ) {
      // Only claim this user as synced once we can actually start — otherwise a
      // sign-in landing mid-flight (the startup anonymous sync still running)
      // would set the ref and then syncNow() would early-return on its in-flight
      // guard, and with the ref already matching, the effect would never retry.
      // Gating on isSyncing makes the effect re-run when the in-flight sync
      // settles, so the new user's pull still fires.
      lastSyncedUserId.current = auth.userId;
      void syncNow();
    }
  }, [bookmarks, auth.userId, auth.status, isSyncing, syncNow]);

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      loadError,
      inbox: loadedBookmarks
        .filter((bookmark) => !bookmark.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      trash: loadedBookmarks
        .filter((bookmark) => bookmark.deleted_at !== null && bookmark.deleted_at !== undefined)
        .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '')),
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      updateBookmarkFields,
      deleteBookmark,
      isSyncing,
      syncNow,
      lastPulledAt,
      collections: tagData.collections,
      addTagsToBookmark,
      removeTagFromBookmark,
      requestAiEnrichment,
      isEnriching,
      isManuallyEnriching,
      acceptSuggestedTags,
      getReviewedSuggestions,
      markSuggestionsReviewed,
      clearReviewedSuggestions,
      unseenSuggestionIds,
      markSuggestionsSeen,
      clearUnseenSuggestions,
      assignCollection,
      createCollection,
    }),
    [
      bookmarks,
      loadError,
      loadedBookmarks,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      updateBookmarkFields,
      deleteBookmark,
      isSyncing,
      syncNow,
      lastPulledAt,
      tagData.collections,
      addTagsToBookmark,
      removeTagFromBookmark,
      requestAiEnrichment,
      isEnriching,
      isManuallyEnriching,
      acceptSuggestedTags,
      getReviewedSuggestions,
      markSuggestionsReviewed,
      clearReviewedSuggestions,
      unseenSuggestionIds,
      markSuggestionsSeen,
      clearUnseenSuggestions,
      assignCollection,
      createCollection,
    ],
  );

  return <BookmarksContext.Provider value={value}>{children}</BookmarksContext.Provider>;
}

export function useBookmarks() {
  const context = useContext(BookmarksContext);
  if (!context) {
    throw new Error('useBookmarks must be used within a BookmarksProvider');
  }
  return context;
}
