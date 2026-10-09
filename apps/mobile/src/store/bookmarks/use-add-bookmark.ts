import {
  imageTitleFromFileName,
  localImageFileName,
  type SharedImage
} from "@/domain/image-share";
import { mockUserId } from "@/domain/mock-data";
import { changedSyncFields } from "@/domain/sync-changes";
import type {
  Bookmark,
  LocalPendingBookmark,
  SyncChangeSource, TextFormat
} from "@/domain/types";
import { isRepairableSourceTitle } from "@/domain/url-title";
import { canonicalizeUrl, isUrlTooLong, normalizeUrl } from "@/domain/urls";
import {
  copyImageToLibrary
} from "@/storage/image-store";
import { repository } from "@/storage/repository";
import { currentDedupeKey, isActiveBookmark, isBookmarkSyncedOnce, logStorageError, makeBookmarkId, makeClientId } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AddBookmarkResult } from '@/store/bookmarks/types';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  hideAccountCache: boolean;
  loadedBookmarks: Bookmark[];
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  localCreateFlushesInFlight: RefObject<number>;
  syncPendingRef: RefObject<boolean>;
  syncPendingForceRef: RefObject<boolean>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
  enrichInBackground: (bookmark: Bookmark) => void;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  bookmarksRef: RefObject<Bookmark[] | null>;
  pendingUserTitleEdits: RefObject<Set<string>>;
  markEnrichmentStale: (bookmarkId: string) => void;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => void;
}

export function useAddBookmark({
  hideAccountCache,
  loadedBookmarks,
  setBookmarks,
  setQueue,
  localCreateFlushesInFlight,
  syncPendingRef,
  syncPendingForceRef,
  syncNowRef,
  enrichInBackground,
  hasSyncedOnce,
  bookmarksRef,
  pendingUserTitleEdits,
  markEnrichmentStale,
  enqueueMutation,
}: Dependencies) {

  const addBookmark = useCallback(
    ({
      url,
      title,
      title_is_derived = false,
      notes,
      replace_existing_notes = false,
      capture_client_id,
      description_format = "plain",
      notes_format = "plain",
      shared_text,
      image,
    }: {
      url?: string;
      title?: string;
      title_is_derived?: boolean;
      notes?: string;
      replace_existing_notes?: boolean;
      capture_client_id?: string;
      description_format?: TextFormat;
      notes_format?: TextFormat;
      shared_text?: string;
      image?: SharedImage;
    }): AddBookmarkResult => {
      const captureBookmarks = hideAccountCache
        ? loadedBookmarks.filter((row) => !isBookmarkSyncedOnce(row))
        : loadedBookmarks;
      const replayedCapture = capture_client_id
        ? captureBookmarks.find(
          // Capture ids are idempotency keys, unlike content URLs: a replay
          // must find its original row even if the user trashed it after an
          // acknowledgement failure. Creating another row would later
          // conflict with the cloud's all-rows client_id uniqueness too.
          (bookmark) => bookmark.client_id === capture_client_id,
        )
        : undefined;
      if (replayedCapture) {
        return {
          status: "duplicate",
          bookmark: replayedCapture,
          persisted: Promise.resolve(true),
        };
      }
      // A shared image becomes an image bookmark: capture is local-first and
      // optimistic exactly like every other save, then queued for a real
      // background upload (binary to Storage, then the row) — same shape as
      // the text-note path below. sync_status starts 'pending' (not the old
      // fake 'synced' bookkeeping trick) so the orphan reconciler and the
      // Inbox/Detail "sync pending" chip both read it honestly; `local_image_uri`
      // still keeps it rendering locally with zero dependency on the network
      // the whole time (isLocalOnlyBookmark/STASH-65 continues to protect it
      // from the remote-deletion diff until ever_synced actually flips true on
      // a confirmed upload). Capture is sacred: the durable file copy is
      // folded into `persisted` so the share handler only dismisses once it
      // has actually landed on disk.
      if (image) {
        const now = new Date().toISOString();
        const id = makeBookmarkId();
        const fileName = localImageFileName(id, image);
        // Not a content key (there's no URL to dedupe on) — this capture's
        // stable id, resent unchanged on every upload retry so an interrupted
        // create dedupes against its own first attempt instead of inserting a
        // twin, same role it plays for text notes.
        const imageClientId = capture_client_id ?? makeClientId();
        const imageBookmark: Bookmark = {
          id,
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: imageClientId,
          // A title typed at capture is user-authored; otherwise derive a
          // readable one from the shared filename (may be null → "Untitled").
          title: title?.trim()
            ? title.trim()
            : imageTitleFromFileName(image.fileName),
          title_is_derived: title?.trim() ? title_is_derived : undefined,
          description: null,
          notes: notes?.length ? notes : null,
          description_format,
          notes_format,
          source_app: null,
          content_type: "image",
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
          metadata_status: "skipped",
          sync_status: "pending",
          // Temporary share URI for the optimistic render; swapped for the
          // durable copy once `copyImageToLibrary` resolves below.
          local_image_uri: image.uri,
          // The real MIME type the OS share sheet reported — recorded now
          // because it's the only place this is ever known; the durable
          // local file's own extension alone can't always be trusted to
          // recover it later (see the field's doc comment in domain/types.ts).
          local_image_mime_type: image.mimeType,
        };

        const imageEntry: LocalPendingBookmark = {
          local_id: id,
          remote_id: null,
          operation: "create",
          changes: [{ source: "capture", fields: [], at: now }],
          payload: {
            id,
            // The explicit signal requirePayload needs — there's no
            // url/shared_text to infer content_type from for this row. The
            // binary itself is uploaded by the sync engine right before it
            // sends this create (see syncQueueEntry), never here.
            content_type: "image",
            title: imageBookmark.title ?? undefined,
            notes: imageBookmark.notes ?? undefined,
            description_format: imageBookmark.description_format,
            notes_format: imageBookmark.notes_format,
            client_id: imageClientId,
          },
          sync_status: "pending",
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        };

        setBookmarks((current) => [imageBookmark, ...(current ?? [])]);
        setQueue((current) => [...current, imageEntry]);
        // A real (potentially slow, for a large screenshot/photo) file copy
        // sits between this optimistic update and the durable insert+enqueue
        // below — unlike the URL/text capture paths, which have no
        // meaningful I/O in that gap. That's long enough for the 250ms
        // auto-sync debounce to fire syncNow first, and syncNow
        // unconditionally reloads bookmarks/queue from the repository and
        // REPLACES React state with that snapshot (deliberate, for
        // account-transition correctness — see the comment above
        // `reconcileAccountTransition` in syncNow). If that reload runs
        // before this row durably lands, it wipes the just-captured image
        // straight out of the UI — not off disk (the durable write still
        // lands and the row is recovered on the NEXT full reload), but gone
        // from the screen and out of live sync tracking until then, which
        // looks exactly like data loss to the user. `localCreateFlushesInFlight`
        // is the existing guard for precisely this shape of problem — see
        // `importBookmarks` and docs/architecture/sync-pause-import-reset.md
        // — `syncNow`/`resetLibrary` already defer while it's nonzero and
        // self-retrigger once it clears, so reusing it here needs no changes
        // to either of them.
        localCreateFlushesInFlight.current += 1;
        const persisted = ensureRepositoryReady()
          .then(() => copyImageToLibrary(image.uri, fileName))
          .then((durableUri) => {
            const stored: Bookmark = {
              ...imageBookmark,
              local_image_uri: durableUri,
            };
            setBookmarks((current) =>
              current === null
                ? current
                : current.map((b) => (b.id === id ? stored : b)),
            );
            // Sequential, not Promise.all: insert the bookmark row FIRST,
            // then enqueue. A crash between the two durable writes must land
            // on the side reconcileOrphanedQueueEntries already self-heals
            // (a bookmark with no queue entry yet) — not a queue entry with
            // no matching bookmark row, which would retry the create forever
            // (requirePayload rejects an image create with no
            // preview_image_url, and createUploadPayload's own "row is
            // missing" guard returns the payload unchanged, so the image
            // never re-uploads either). Running the two writes concurrently
            // via Promise.all leaves the order — and therefore which of the
            // two partial states a crash lands on — unspecified.
            return repository
              .insertBookmark(stored)
              .then(() => repository.enqueue(imageEntry));
          })
          .then(() => true)
          .catch((error) => {
            logStorageError("new image bookmark", error);
            return false;
          })
          .finally(() => {
            // Mirrors importBookmarks' own flush completion exactly: once
            // the last in-flight local write clears, release any sync a
            // debounce fired (and got deferred) during the window, and
            // explicitly kick a fresh one so the just-landed row/entry
            // actually gets picked up instead of waiting for the next
            // unrelated trigger.
            localCreateFlushesInFlight.current = Math.max(
              0,
              localCreateFlushesInFlight.current - 1,
            );
            if (localCreateFlushesInFlight.current === 0) {
              syncPendingRef.current = false;
              const pendingForce = syncPendingForceRef.current;
              syncPendingForceRef.current = false;
              setTimeout(() => {
                void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
              }, 50);
            }
          });

        return { status: "created", bookmark: imageBookmark, persisted };
      }

      const normalized = url ? normalizeUrl(url) : null;
      if (!normalized) {
        // No usable URL. If the share carried text (e.g. a KakaoTalk message
        // with no link), save it as a text note rather than dropping deliberately
        // shared content — capture is sacred. Reject only when there is nothing
        // at all to save.
        if (!shared_text?.trim()) {
          return {
            status: "invalid",
            error:
              "Enter a valid web address, like example.com or https://example.com.",
          };
        }
        // Test emptiness on a trimmed copy above, but persist the original
        // body — leading whitespace is meaningful Markdown (e.g. an indented
        // code block), so a Markdown memo must not be silently rewritten.
        const text = shared_text;

        const noteNow = new Date().toISOString();
        // Text notes have no canonical URL key, so distinct shares are distinct
        // notes by design. The client_id below is NOT a content key: it's this
        // capture's stable id, resent on every retry so an interrupted upload
        // dedupes against its own first attempt instead of inserting a twin.
        const noteClientId = capture_client_id ?? makeClientId();
        const note: Bookmark = {
          id: makeBookmarkId(),
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: noteClientId,
          title: title?.trim() ? title.trim() : null,
          title_is_derived: title?.trim() ? title_is_derived : undefined,
          // The shared text is the note's body. Stored as the description to
          // mirror the cloud API (which maps shared_text → description), so a
          // pulled-back note matches the locally captured one.
          description: text,
          notes: notes?.length ? notes : null,
          description_format,
          notes_format,
          source_app: null,
          content_type: "text",
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: noteNow,
          updated_at: noteNow,
          last_saved_at: noteNow,
          metadata_status: "pending",
          sync_status: "pending",
        };

        const noteEntry: LocalPendingBookmark = {
          local_id: note.id,
          remote_id: null,
          operation: "create",
          changes: [{ source: "capture", fields: [], at: noteNow }],
          payload: {
            id: note.id,
            title: note.title ?? undefined,
            notes: note.notes ?? undefined,
            description_format: note.description_format,
            notes_format: note.notes_format,
            shared_text: text,
            client_id: noteClientId,
          },
          sync_status: "pending",
          retry_count: 0,
          last_error: null,
          created_at: noteNow,
          updated_at: noteNow,
        };

        setBookmarks((current) => [note, ...(current ?? [])]);
        setQueue((current) => [...current, noteEntry]);
        const persisted = ensureRepositoryReady()
          .then(() =>
            Promise.all([
              repository.insertBookmark(note),
              repository.enqueue(noteEntry),
            ]),
          )
          .then(() => true)
          .catch((error) => {
            logStorageError("new text note", error);
            return false;
          });

        // No URL to derive metadata from; this transitions metadata_status to
        // 'skipped' via the existing, tested enrichment path.
        enrichInBackground(note);

        return { status: "created", bookmark: note, persisted };
      }

      const now = new Date().toISOString();

      // Idempotent saves: reuse the existing bookmark for the same URL. Dedupe
      // on the canonical form so tracking params / fragments don't create dupes.
      const dedupeKey = canonicalizeUrl(normalized);

      // Reject up front rather than queuing a save that can never succeed: the
      // server's `url_hash` index has a Postgres row-size limit that a sufficiently
      // long canonical URL blows on every retry, forever (Sentry STASH-2V / STASH-2J).
      if (isUrlTooLong(dedupeKey)) {
        return {
          status: "invalid",
          error: "This web address is too long to save.",
          reason: "too_long",
        };
      }

      const existing = captureBookmarks.find(
        (bookmark) =>
          isActiveBookmark(bookmark) &&
          currentDedupeKey(bookmark) === dedupeKey,
      );
      if (existing) {
        const isRepairable = isRepairableSourceTitle(existing);
        const titleCanBeImproved =
          Boolean(title?.trim()) &&
          (!title_is_derived ||
            existing.title == null ||
            existing.title_is_derived === true ||
            isRepairable);
        const updatedTitle = titleCanBeImproved ? title!.trim() : existing.title;
        const updatedTitleDerived = titleCanBeImproved
          ? title_is_derived
          : isRepairable
            ? true
            : existing.title_is_derived;

        const notesCanBeImproved = Boolean(notes?.trim()) &&
          (replace_existing_notes || !existing.notes);
        const updatedNotes = notesCanBeImproved ? (notes ?? null) : existing.notes;
        const updatedNotesFormat = notesCanBeImproved ? notes_format : existing.notes_format;
        const notesChanged = notesCanBeImproved && updatedNotes !== existing.notes;
        const notesFormatChanged = updatedNotesFormat !== existing.notes_format;

        const needsMetadataRefresh =
          Boolean(existing.url) &&
          (updatedTitle == null || updatedTitleDerived === true || isRepairable);

        const titleChanged = titleCanBeImproved && updatedTitle !== existing.title;
        // A native share's attempt id is also its retry key.  When a URL is
        // already present under its canonical form, retain that key on the
        // existing row before acknowledging the Android intent.  A later
        // replay can then find this row even after the user changes its URL or
        // moves it to Trash, instead of treating the edited content as new.
        const captureClientIdChanged =
          capture_client_id !== undefined && existing.client_id !== capture_client_id;
        const contentChanged =
          titleChanged || notesChanged || notesFormatChanged || captureClientIdChanged;
        const syncsRemotely = contentChanged ? hasSyncedOnce(existing.id) : false;

        const updated: Bookmark = {
          ...existing,
          title: updatedTitle,
          title_is_derived: updatedTitleDerived,
          client_id: capture_client_id ?? existing.client_id,
          notes: updatedNotes,
          notes_format: updatedNotesFormat,
          last_saved_at: now,
          last_accessed_at: now,
          updated_at: contentChanged ? now : existing.updated_at,
          sync_status: syncsRemotely ? "pending" : existing.sync_status,
          ever_synced: syncsRemotely ? true : existing.ever_synced,
          metadata_status: needsMetadataRefresh ? "pending" : existing.metadata_status,
        };

        setBookmarks((current) =>
          (current ?? []).map((bookmark) =>
            bookmark.id === existing.id ? updated : bookmark,
          ),
        );
        if (bookmarksRef.current !== null) {
          bookmarksRef.current = bookmarksRef.current.map((bookmark) =>
            bookmark.id === existing.id ? updated : bookmark,
          );
        }
        const persisted = ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .then(() => true)
          .catch((error) => {
            logStorageError("duplicate save", error);
            return false;
          });

        if (titleChanged && !title_is_derived && !hasSyncedOnce(existing.id)) {
          pendingUserTitleEdits.current.add(existing.id);
        }
        if (titleChanged || notesChanged) {
          markEnrichmentStale(existing.id);
        }

        if (syncsRemotely) {
          enqueueMutation(existing.id, "update", "capture", changedSyncFields(existing, updated));
        }

        if (needsMetadataRefresh) {
          // Clear repairable title on the refresh target so enrichBookmark emits a title patch
          // even when the incoming duplicate share supplied no title (Codex review)
          enrichInBackground({
            ...updated,
            title: isRepairable && !titleCanBeImproved ? null : updated.title,
            title_is_derived: isRepairable ? true : updated.title_is_derived,
          });
        }

        return { status: "duplicate", bookmark: updated, persisted };
      }

      const clientId = capture_client_id ?? makeClientId();
      const bookmark: Bookmark = {
        id: makeBookmarkId(),
        user_id: mockUserId,
        url: normalized,
        canonical_url: null,
        // Canonical dedupe key (tracking params/fragment stripped). canonical_url
        // stays null until enrichment resolves a real rel=canonical / og:url.
        url_hash: dedupeKey,
        client_id: clientId,
        // Manual Add titles are user-authored. Source-app share titles are
        // generated hints and may be improved by enrichment (STASH-6C).
        title: title?.trim() ? title.trim() : null,
        title_is_derived: title?.trim() ? title_is_derived : undefined,
        description: null,
        notes: notes?.length ? notes : null,
        description_format,
        notes_format,
        source_app: null,
        content_type: "url",
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: "pending",
        sync_status: "pending",
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        operation: "create",
        changes: [{ source: "capture", fields: [], at: now }],
        payload: {
          id: bookmark.id,
          url: normalized,
          title: bookmark.title ?? undefined,
          notes: bookmark.notes ?? undefined,
          description_format: bookmark.description_format,
          notes_format: bookmark.notes_format,
          client_id: clientId,
        },
        sync_status: "pending",
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
          Promise.all([
            repository.insertBookmark(bookmark),
            repository.enqueue(queueEntry),
          ]),
        )
        .then(() => true)
        .catch((error) => {
          logStorageError("new bookmark", error);
          return false;
        });

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: "created", bookmark, persisted };
    },
    [loadedBookmarks, hideAccountCache, enrichInBackground, hasSyncedOnce, enqueueMutation, markEnrichmentStale],
  );
  return { addBookmark };
}
