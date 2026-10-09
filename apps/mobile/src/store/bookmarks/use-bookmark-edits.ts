import type {
  EnrichmentMetadataHint
} from "@/api/bookmarks";
import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import { enrichBookmark } from "@/domain/enrichment";
import { isTransientNetworkError } from "@/domain/network-errors";
import { checkYoutubeAvailability, isYoutubeAvailabilityCandidate } from "@/domain/page-metadata";
import { clearPreviewImageFailed } from "@/domain/preview-image-cache";
import { changedSyncFields } from "@/domain/sync-changes";
import type {
  AIEnrichment,
  Bookmark,
  SyncChangeSource,
  TextFormat
} from "@/domain/types";
import { isRepairableSourceTitle } from "@/domain/url-title";
import { recordLog } from "@/observability/log-buffer";
import { repository } from "@/storage/repository";
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  bookmarksRef: RefObject<Bookmark[] | null>;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  videoAvailabilityCheckingRef: RefObject<Set<string>>;
  applyBookmarkUpdate: (id: string, patch: Partial<Bookmark>, source?: SyncChangeSource) => void;
  clearAiRetry: (bookmarkId: string) => void;
  syncAiRetryIds: () => void;
  clearAiServerQueued: (bookmarkId: string) => void;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  pendingUserTitleEdits: RefObject<Set<string>>;
  markEnrichmentStale: (bookmarkId: string) => void;
  previewRefreshingIds: ReadonlySet<string>;
  setPreviewRefreshingIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  markPendingAiPreviewRefresh: (id: string) => void;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => void;
  noteQueuedChange: (id: string, source: SyncChangeSource, fields: string[]) => void;
  pendingAiPreviewRefresh: RefObject<Set<string>>;
  aiSuggestionsModeRef: RefObject<AiSuggestionsMode>;
  requestAiEnrichmentRef: RefObject<((bookmarkId: string, source?: "auto" | "manual" | "preview", overrideMetadata?: EnrichmentMetadataHint) => Promise<string | null>) | null>;
  clearPendingAiPreviewRefresh: (id: string) => void;
}

export function useBookmarkEdits({
  bookmarksRef,
  setBookmarks,
  videoAvailabilityCheckingRef,
  applyBookmarkUpdate,
  clearAiRetry,
  syncAiRetryIds,
  clearAiServerQueued,
  hasSyncedOnce,
  pendingUserTitleEdits,
  markEnrichmentStale,
  previewRefreshingIds,
  setPreviewRefreshingIds,
  markPendingAiPreviewRefresh,
  setEnrichments,
  enqueueMutation,
  noteQueuedChange,
  pendingAiPreviewRefresh,
  aiSuggestionsModeRef,
  requestAiEnrichmentRef,
  clearPendingAiPreviewRefresh,
}: Dependencies) {

  // Record that the user just opened a bookmark (viewed its Detail or opened its
  // link), powering the "Recently opened" Inbox sort. Deliberately NOT routed
  // through applyBookmarkUpdate: last_accessed_at is a local-only field, so this
  // must not flip sync_status, enqueue a sync mutation, or bump updated_at (which
  // would wrongly re-send the row on the next sync). Just patch in memory and
  // persist locally, fire-and-forget.
  const markBookmarkAccessed = useCallback((id: string) => {
    // Build the updated row from the ref, not inside the setBookmarks updater:
    // the functional updater isn't guaranteed to run synchronously, so reading a
    // value it assigned would race the durable write below and could skip it,
    // leaving last_accessed_at lost after a reload.
    const existing = bookmarksRef.current?.find(
      (bookmark) => bookmark.id === id,
    );
    if (!existing) {
      return;
    }
    const updated: Bookmark = {
      ...existing,
      last_accessed_at: new Date().toISOString(),
    };
    setBookmarks((current) =>
      current === null
        ? current
        : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
    );
    // Keep the ref itself current immediately, not just via the `useEffect`
    // that mirrors it from `bookmarks` after the next render — same
    // rationale as applyBookmarkUpdate's identical line above: a bulk-create
    // reconcile pass reading bookmarksRef.current concurrently must see this
    // access timestamp, not a stale pre-access snapshot it would otherwise
    // write back and silently clobber (caught in PR review).
    bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
      bookmark.id === id ? updated : bookmark,
    );
    ensureRepositoryReady()
      .then(() => repository.updateBookmark(updated))
      .catch((error) => logStorageError("bookmark access", error));
  }, []);

  // On-demand YouTube availability check (STASH-61). Takes the URL from the
  // caller rather than re-reading it off `bookmarksRef` — the caller (a
  // Detail-screen mount effect) already has the just-rendered bookmark in
  // hand, whereas `bookmarksRef` is only mirrored from `bookmarks` state by a
  // separate effect and can still be a render behind on the very first mount
  // after the initial load, which would otherwise silently no-op the check.
  // Deliberately NOT routed through applyBookmarkUpdate, for the same reason
  // as markBookmarkAccessed above: video_unavailable is a local-only,
  // self-healing status read, not user- or server-authored data, so it must
  // never flip sync_status, enqueue a sync mutation, or bump updated_at.
  const checkVideoAvailability = useCallback((id: string, url: string | null | undefined) => {
    if (!url || !isYoutubeAvailabilityCandidate(url)) {
      // If a non-candidate (such as a YouTube playlist or non-YouTube URL)
      // previously had video_unavailable set, self-heal by clearing it (STASH-71).
      const latest = bookmarksRef.current?.find((bookmark) => bookmark.id === id);
      if (latest?.video_unavailable) {
        const updated: Bookmark = { ...latest, video_unavailable: false };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
        );
        bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
          bookmark.id === id ? updated : bookmark,
        );
        ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .catch((error) =>
            logStorageError("clear invalid video_unavailable", error),
          );
      }
      return;
    }
    if (videoAvailabilityCheckingRef.current.has(id)) {
      return;
    }
    videoAvailabilityCheckingRef.current.add(id);
    checkYoutubeAvailability(url)
      .then((result) => {
        if (result === "unknown") {
          // Indeterminate (network error, timeout, non-OK status): leave the
          // current flag as-is rather than guess.
          return;
        }
        // STASH-71: 'unavailable' marks the video as unavailable. 'available' and
        // 'not_applicable' (such as a short link that resolved to a playlist or
        // non-video) clear any stale video_unavailable flag.
        const unavailable = result === "unavailable";
        const latest = bookmarksRef.current?.find(
          (bookmark) => bookmark.id === id,
        );
        if (!latest || (latest.video_unavailable ?? false) === unavailable) {
          // Already reflects this result (or the bookmark is gone) — no write.
          return;
        }
        const updated: Bookmark = { ...latest, video_unavailable: unavailable };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
        );
        bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
          bookmark.id === id ? updated : bookmark,
        );
        return ensureRepositoryReady().then(() =>
          repository.updateBookmark(updated),
        );
      })
      .catch((error) => logStorageError("video availability check", error))
      .finally(() => {
        videoAvailabilityCheckingRef.current.delete(id);
      });
  }, []);

  const trashBookmark = useCallback(
    (id: string) => {
      applyBookmarkUpdate(id, { deleted_at: new Date().toISOString() }, "trash");
      // Trashed: nothing left to retry enriching until restored — mirrors
      // deleteBookmark's cleanup so a discarded bookmark doesn't keep
      // consuming retry attempts (and, if one eventually succeeds, silently
      // write fresh AI suggestions for content the user just discarded).
      clearAiRetry(id);
      syncAiRetryIds();
      // A trashed bookmark has nothing left to wait for either — clear a
      // confirmed-server-queue marker the same way.
      clearAiServerQueued(id);
    },
    [applyBookmarkUpdate, clearAiRetry, syncAiRetryIds, clearAiServerQueued],
  );

  const restoreBookmark = useCallback(
    (id: string) => applyBookmarkUpdate(id, { deleted_at: null }, "restore"),
    [applyBookmarkUpdate],
  );

  const updateBookmarkFields = useCallback(
    (
      id: string,
      fields: { title?: string; notes?: string; description?: string; description_format?: TextFormat; notes_format?: TextFormat },
      source: "user_edit" | "ai_apply" = "user_edit",
    ) => {
      const before = bookmarksRef.current?.find(
        (bookmark) => bookmark.id === id,
      );
      const patch: Partial<Bookmark> = {};
      if (fields.title !== undefined) {
        patch.title = fields.title.trim() || null;
        patch.title_is_derived = patch.title === null ? undefined : false;
      }
      if (fields.notes !== undefined) {
        patch.notes = fields.notes.length ? fields.notes : null;
      }
      if (fields.description !== undefined) {
        // Preserve authored whitespace in both formats, including code indentation.
        patch.description = fields.description.length ? fields.description : null;
      }
      if (fields.description_format !== undefined) {
        patch.description_format = fields.description_format;
      }
      if (fields.notes_format !== undefined) {
        patch.notes_format = fields.notes_format;
      }
      // Only stale on a real change to user-editable text; a no-op save (or a
      // collection/archive change, which never routes through here) must not.
      const textChanged =
        (patch.title !== undefined &&
          patch.title !== (before?.title ?? null)) ||
        (patch.notes !== undefined && patch.notes !== (before?.notes ?? null)) ||
        (patch.description !== undefined &&
          patch.description !== (before?.description ?? null));
      applyBookmarkUpdate(id, patch, source);
      if (textChanged) {
        if (patch.title !== undefined && !hasSyncedOnce(id)) {
          pendingUserTitleEdits.current.add(id);
        }
        markEnrichmentStale(id);
      }
    },
    [applyBookmarkUpdate, hasSyncedOnce, markEnrichmentStale],
  );

  const refreshBookmarkPreview = useCallback(
    async (id: string): Promise<string | null> => {
      const bookmark = bookmarksRef.current?.find((item) => item.id === id);
      if (!bookmark?.url) {
        return "Preview refresh needs a URL bookmark.";
      }
      if (previewRefreshingIds.has(id)) {
        return null;
      }
      setPreviewRefreshingIds((prev) => new Set(prev).add(id));
      try {
        if (bookmark.preview_image_url) {
          clearPreviewImageFailed(bookmark.preview_image_url);
        }
        if (bookmark.local_image_uri) {
          clearPreviewImageFailed(bookmark.local_image_uri);
        }
        // Older Android captures marked Reddit's generic EXTRA_TITLE
        // ("Reddit") as user-authored. Preview Refresh is an explicit request
        // to fetch better metadata, so repair that one known provenance mistake
        // while continuing to preserve every ordinary manual title.
        const userTitle =
          bookmark.title_is_derived === false &&
          !isRepairableSourceTitle(bookmark);
        const refreshTarget: Bookmark = {
          ...bookmark,
          title: userTitle ? bookmark.title : null,
          site_name: null,
          favicon_url: null,
          preview_image_url: null,
        };
        const { patch, metadata_status } = await enrichBookmark(refreshTarget);
        const latest =
          bookmarksRef.current?.find((item) => item.id === id) ?? bookmark;
        // A title edit can land while the metadata request is in flight. Only
        // apply the fetched title if both the value and its provenance still
        // match the snapshot the refresh started from; generated site/image
        // fields may still refresh independently.
        const titleStillRefreshable =
          !userTitle &&
          latest.title === bookmark.title &&
          latest.title_is_derived === bookmark.title_is_derived;
        const nextPatch: Partial<Bookmark> = { metadata_status };
        if (titleStillRefreshable && patch.title !== undefined) {
          // If the patch title was just a URL-derived fallback (no real title was fetched from the page)
          // and the bookmark already had a title, do not degrade the existing title unless the existing
          // title is a known repairable placeholder (e.g. 'Bbs View' or 'Reddit').
          const wouldDegradeExistingTitle =
            patch.title_is_derived === true &&
            Boolean(bookmark.title?.trim()) &&
            !isRepairableSourceTitle(bookmark);
          if (!wouldDegradeExistingTitle) {
            nextPatch.title = patch.title;
            nextPatch.title_is_derived = patch.title_is_derived;
          }
        }
        if (patch.site_name !== undefined) {
          nextPatch.site_name = patch.site_name;
        }
        if (patch.favicon_url !== undefined) {
          nextPatch.favicon_url = patch.favicon_url;
        }
        if (patch.preview_image_url !== undefined) {
          nextPatch.preview_image_url = patch.preview_image_url;
        }
        const syncsRemotely = hasSyncedOnce(id);
        const updated: Bookmark = {
          ...latest,
          ...nextPatch,
          sync_status: syncsRemotely ? "pending" : latest.sync_status,
          ever_synced: syncsRemotely ? true : latest.ever_synced,
          updated_at: new Date().toISOString(),
        };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((item) => (item.id === id ? updated : item)),
        );
        // Keep the ref current immediately — same rationale as
        // enrichInBackground's identical line: another local-only writer
        // (checkVideoAvailability) reading bookmarksRef.current moments later
        // must see this refreshed metadata, not a pre-refresh snapshot it
        // would otherwise revert (PR review, STASH-61).
        bookmarksRef.current = bookmarksRef.current
          ? bookmarksRef.current.map((item) => (item.id === id ? updated : item))
          : bookmarksRef.current;
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
          if (metadata_status === "failed") {
            // Its later successful update may coalesce over an unchanged
            // cloud metadata status, leaving the server trigger nothing to
            // dispatch from. Preserve a direct-refresh marker either way.
            markPendingAiPreviewRefresh(id);
            await repository.deleteEnrichment(id);
            setEnrichments((current) =>
              current.filter((item) => item.bookmark_id !== id),
            );
          }
        } catch (error) {
          logStorageError("preview refresh", error);
        }
        if (syncsRemotely) {
          enqueueMutation(id, "update", "preview_refresh", changedSyncFields(latest, nextPatch));
        } else {
          noteQueuedChange(id, "preview_refresh", changedSyncFields(latest, nextPatch));
        }
        // STASH #573: 'off' means never auto-trigger AI enrichment. This is a
        // direct continuation of the user's own "refresh preview" tap (not a
        // background batch), so it fires immediately rather than through the
        // staggered burst queue below.
        const needsDirectPreviewRefresh =
          pendingAiPreviewRefresh.current.has(id);
        if (
          metadata_status !== "failed" &&
          aiSuggestionsModeRef.current !== "off" &&
          // A failed → complete refresh is dispatched by the installed
          // ai_enrich_dispatch trigger when this update uploads. A second
          // direct request would consume two slots and race its response.
          !(latest.metadata_status === "failed" &&
            metadata_status === "complete" &&
            !needsDirectPreviewRefresh)
        ) {
          void requestAiEnrichmentRef
            .current?.(id, "preview", {
              title: updated.title,
              description: updated.description,
              notes: updated.notes,
              site_name: updated.site_name,
              content_type: updated.content_type,
            })
            .then((error) => {
              if (!error) {
                clearPendingAiPreviewRefresh(id);
              }
            })
            .catch(() => { });
        }
        return null;
      } catch (error) {
        recordLog(
          isTransientNetworkError(error) ? "warn" : "error",
          `preview refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "Could not refresh the preview.";
      } finally {
        setPreviewRefreshingIds((prev) => {
          if (!prev.has(id)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [
      enqueueMutation,
      noteQueuedChange,
      previewRefreshingIds,
      hasSyncedOnce,
      markPendingAiPreviewRefresh,
      clearPendingAiPreviewRefresh,
    ],
  );
  return { markBookmarkAccessed, checkVideoAvailability, trashBookmark, restoreBookmark, updateBookmarkFields, refreshBookmarkPreview };
}
