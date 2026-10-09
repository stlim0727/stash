import { isContentType, type ImportItem } from "@/domain/import";
import { mockUserId } from "@/domain/mock-data";
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  enqueuePendingEnrichmentRestore,
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  enqueuePendingImportCollection,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import {
  applyTagOp,
  enqueueTagOp,
  type PendingTagOp
} from "@/domain/pending-tags";
import type {
  Bookmark, ContentType,
  LocalPendingBookmark,
  MetadataStatus
} from "@/domain/types";
import { canonicalizeUrl, isUrlTooLong, normalizeUrl } from "@/domain/urls";
import { makeUuid } from "@/domain/uuid";
import { recordLog } from "@/observability/log-buffer";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { PENDING_TAG_OPS_KEY } from '@/store/bookmarks/constants';
import { currentDedupeKey, isActiveBookmark, logStorageError, makeBookmarkId, makeClientId } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type ImportSummary } from '@/store/bookmarks/types';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import {
  hasRemoteIdentity
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  bookmarksRef: RefObject<Bookmark[] | null>;
  isSyncingState: boolean;
  tagWorkPending: RefObject<number>;
  loadedBookmarks: Bookmark[];
  tagDataRef: RefObject<TagData>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  pendingImportCollectionsRef: RefObject<PendingImportCollection[]>;
  pendingEnrichmentRestoresRef: RefObject<PendingEnrichmentRestore[]>;
  auth: ReturnType<typeof useSupabaseAuth>;
  setPendingTagOps: Dispatch<SetStateAction<PendingTagOp[]>>;
  setTagData: Dispatch<SetStateAction<TagData>>;
  setPendingImportCollections: Dispatch<SetStateAction<PendingImportCollection[]>>;
  setPendingEnrichmentRestores: Dispatch<SetStateAction<PendingEnrichmentRestore[]>>;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  localCreateFlushesInFlight: RefObject<number>;
  enriching: RefObject<Set<string>>;
  enrichInBackground: (bookmark: Bookmark) => void;
  serializeTagWork: <T>(work: () => Promise<T>) => Promise<T>;
  resetEpoch: RefObject<number>;
  syncPendingRef: RefObject<boolean>;
  syncPendingForceRef: RefObject<boolean>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
}

export function useImportBookmarks({
  bookmarksRef,
  isSyncingState,
  tagWorkPending,
  loadedBookmarks,
  tagDataRef,
  pendingTagOpsRef,
  pendingImportCollectionsRef,
  pendingEnrichmentRestoresRef,
  auth,
  setPendingTagOps,
  setTagData,
  setPendingImportCollections,
  setPendingEnrichmentRestores,
  setBookmarks,
  setQueue,
  localCreateFlushesInFlight,
  enriching,
  enrichInBackground,
  serializeTagWork,
  resetEpoch,
  syncPendingRef,
  syncPendingForceRef,
  syncNowRef,
}: Dependencies) {

  // Bulk re-ingest of imported items. Mirrors addBookmark's local-first create
  // (optimistic insert + queued create + background enrichment) but batches the
  // whole file into one state update, and dedupes within the batch too so a file
  // listing the same URL twice doesn't create duplicates.
  const importBookmarks = useCallback(
    (items: ImportItem[]): ImportSummary => {
      // Sentry STASH-3K/3M, confirmed by reproduction: dedup below only ever
      // sees `bookmarksRef.current`, which is incomplete while the initial
      // local load hasn't landed (bookmarksRef.current still null) or while
      // the account's first cloud pull is still bringing down previously-
      // synced rows (isSyncingState true covers this window too, since the
      // pull-on-first-ready effect fires essentially immediately after load).
      // Importing during either window can't recognize already-existing
      // rows and durably re-creates every one of them as a fresh duplicate —
      // this is the exact "561 -> 1122" doubling reported twice. Refuse
      // outright rather than risk it; the caller asks the user to retry.
      if (bookmarksRef.current === null || isSyncingState || tagWorkPending.current > 0) {
        recordLog(
          "warn",
          `import: refused (not ready) items=${items.length} loaded=${bookmarksRef.current !== null} isSyncing=${isSyncingState}`,
        );
        return { imported: 0, duplicates: 0, skipped: 0, notReady: true };
      }
      const now = new Date().toISOString();
      // Latest committed rows (the ref), so an import right after a save sees it.
      const activeLocalBookmarks = (
        bookmarksRef.current ?? loadedBookmarks
      ).filter((bookmark) => isActiveBookmark(bookmark));
      const bookmarkIdByDedupeKey = new Map(
        activeLocalBookmarks
          .map((bookmark) => [currentDedupeKey(bookmark), bookmark.id] as const)
          .filter((entry): entry is [string, string] => entry[0] !== null),
      );
      const activeBookmarkById = new Map(
        activeLocalBookmarks.map((bookmark) => [bookmark.id, bookmark]),
      );
      const activeBookmarkByClientId = new Map(
        activeLocalBookmarks
          .filter((bookmark) => bookmark.client_id)
          .map((bookmark) => [bookmark.client_id!, bookmark] as const),
      );
      const trashedLocalBookmarks = (bookmarksRef.current ?? loadedBookmarks).filter(
        (bookmark) => !isActiveBookmark(bookmark),
      );
      const trashedBookmarkIds = new Set(
        trashedLocalBookmarks.map((bookmark) => bookmark.id),
      );
      const trashedBookmarkClientIds = new Set(
        trashedLocalBookmarks
          .map((bookmark) => bookmark.client_id)
          .filter((clientId): clientId is string => !!clientId),
      );
      // Sentry STASH-3K/3M: a bulk import has repeatedly doubled a user's
      // library (their local total exactly 2x the cloud count) with no
      // evidence of why — this and the summary log below are the
      // instrumentation needed to tell apart "dedupe ran against a near-empty
      // snapshot" (activeLocal/seenKeys far below the real library size) from
      // "dedupe saw everything but let duplicates through anyway" (seenKeys
      // matches the library size but `duplicates` is still ~0 on a re-import).
      recordLog(
        "info",
        `import: starting items=${items.length} activeLocal=${activeLocalBookmarks.length} seenKeys=${bookmarkIdByDedupeKey.size}`,
      );
      const newBookmarks: Bookmark[] = [];
      const newEntries: LocalPendingBookmark[] = [];
      let nextTagData = tagDataRef.current;
      let nextTagOps = pendingTagOpsRef.current;
      let nextImportCollections = pendingImportCollectionsRef.current;
      let nextEnrichmentRestores = pendingEnrichmentRestoresRef.current;
      let organizationChanged = false;
      let imported = 0;
      let duplicates = 0;
      let skipped = 0;

      for (const item of items) {
        if (!item.url) {
          // A URL-less text/Markdown-memo bookmark: `toJsonBackup` exports it
          // with url: null and its raw body in `description`, so a restore
          // must not fall through to the URL-only skip below — that would
          // silently drop every memo from an advertised full-fidelity backup.
          // Test emptiness on the trimmed value, but restore the untrimmed
          // one — leading/trailing whitespace can be meaningful Markdown
          // (e.g. an indented code block), so a restore must not silently
          // rewrite it. Also require content_type: 'text' — a URL-less
          // *image* bookmark (a captured screenshot) can carry a caption in
          // `description` too, and must not be rebuilt as a fake text memo,
          // which would discard its preview_image_url and mislabel a
          // generated caption as user-authored Markdown.
          const hasMemoContent =
            !!item.metadata?.raw_description?.trim() ||
            !!item.metadata?.description?.trim() ||
            !!item.title?.trim() ||
            !!item.notes?.trim() ||
            item.tags.length > 0 ||
            !!item.collection?.trim();
          if (
            item.source !== "stash-backup" ||
            item.metadata?.content_type !== "text" ||
            !hasMemoContent
          ) {
            skipped += 1;
            continue;
          }
          const memoBody = item.metadata.raw_description ?? item.metadata.description;
          // A URL-less row has no canonical url_hash. Match the backup's
          // identity against an active local row, but never reuse its primary
          // key for a new row: bookmark ids are global, so that id may still
          // belong to the source account in Postgres. The per-user client_id
          // is the safe idempotency key for a newly restored copy.
          const backupDedupeClientId =
            item.backupClientId ??
            (item.backupId && hasRemoteIdentity(item.backupId) ? item.backupId : null);
          const existingId =
            (item.backupId && activeBookmarkById.get(item.backupId)?.id) ||
            (backupDedupeClientId && activeBookmarkByClientId.get(backupDedupeClientId)?.id) ||
            undefined;
          const isNew = existingId === undefined;
          const id = existingId ?? makeBookmarkId();
          if (!isNew) {
            duplicates += 1;
          } else {
            // A trashed row remains visible to the cloud's all-rows client_id
            // lookup. Reusing its identity would make the create adopt that
            // still-deleted row, so a deliberate re-add gets a new capture id.
            const backupIdentityIsTrashed =
              (!!item.backupId && trashedBookmarkIds.has(item.backupId)) ||
              (!!backupDedupeClientId &&
                trashedBookmarkClientIds.has(backupDedupeClientId));
            const clientId =
              backupDedupeClientId && !backupIdentityIsTrashed
                ? backupDedupeClientId
                : makeClientId();
            const title = item.title?.trim() ? item.title.trim() : null;
            const notes = item.notes?.length ? item.notes : null;
            const itemCreatedAt = item.createdAt ?? now;
            const restoredBookmark: Bookmark = {
              id,
              user_id: mockUserId,
              url: null,
              canonical_url: null,
              url_hash: null,
              title,
              title_is_derived: title ? false : undefined,
              client_id: clientId,
              description: memoBody,
              description_format: item.description_format,
              notes_format: item.notes_format,
              notes,
              source_app: null,
              content_type: "text",
              preview_image_url: null,
              favicon_url: null,
              site_name: null,
              collection_id: null,
              is_archived: false,
              deleted_at: null,
              created_at: itemCreatedAt,
              updated_at: now,
              last_saved_at: now,
              // Never 'pending' for a restore — same rationale as the URL
              // branch below: don't let a restored row auto-spend AI quota.
              metadata_status: "skipped",
              sync_status: "pending",
            };
            newBookmarks.push(restoredBookmark);
            // Make a duplicate occurrence in this same import batch resolve
            // exactly like a later re-import after the row has been persisted.
            activeBookmarkById.set(id, restoredBookmark);
            activeBookmarkByClientId.set(clientId, restoredBookmark);
            newEntries.push({
              local_id: id,
              remote_id: null,
              operation: "create",
              changes: [{ source: "import", fields: [], at: now }],
              payload: {
                id,
                shared_text: memoBody ?? undefined,
                title: title ?? undefined,
                notes: notes ?? undefined,
                description_format: item.description_format,
                notes_format: item.notes_format,
                content_type: "text",
                client_id: clientId,
                metadata_status: "skipped",
                enrichment_policy: "skip",
                created_at: itemCreatedAt,
              },
              sync_status: "pending",
              retry_count: 0,
              last_error: null,
              created_at: now,
              updated_at: now,
            });
            imported += 1;
          }

          for (const tagName of item.tags) {
            const op: PendingTagOp = {
              id: makeUuid(),
              bookmark_id: id,
              tag_name: tagName,
              op: "add",
              source: "user",
              confidence: null,
              created_at: now,
            };
            nextTagData = applyTagOp(nextTagData, op, auth.userId ?? mockUserId);
            nextTagOps = enqueueTagOp(nextTagOps, op);
            organizationChanged = true;
          }
          const memoCollectionName = item.collection?.trim();
          const memoTarget = activeBookmarkById.get(id);
          // Same guard as the URL branch below: don't clobber a dedupe-
          // matched existing row's organization.
          if (memoCollectionName && !memoTarget?.collection_id) {
            nextImportCollections = enqueuePendingImportCollection(
              nextImportCollections,
              {
                bookmark_id: id,
                collection_name: memoCollectionName,
                status: "pending",
                last_error: null,
                created_at: now,
              },
            );
            organizationChanged = true;
          }
          if (item.enrichment) {
            nextEnrichmentRestores = enqueuePendingEnrichmentRestore(
              nextEnrichmentRestores,
              {
                bookmark_id: id,
                enrichment: item.enrichment,
                status: "pending",
                last_error: null,
                created_at: now,
              },
            );
            organizationChanged = true;
          }
          continue;
        }
        const normalized = normalizeUrl(item.url);
        if (!normalized) {
          skipped += 1;
          continue;
        }
        const dedupeKey = canonicalizeUrl(normalized);
        // Same permanent-failure guard as addBookmark (Sentry STASH-2V / STASH-2J): a URL
        // whose canonical dedupeKey is long enough to blow the server's url_hash index
        // row-size limit would queue a create that can never succeed. Skip it rather than
        // import a dead entry.
        if (isUrlTooLong(dedupeKey)) {
          skipped += 1;
          continue;
        }
        const existingId = bookmarkIdByDedupeKey.get(dedupeKey);
        const isNew = existingId === undefined;
        const id = existingId ?? makeBookmarkId();
        if (!isNew) {
          duplicates += 1;
        } else {
          bookmarkIdByDedupeKey.set(dedupeKey, id);
        }
        if (isNew) {
          const clientId = makeClientId();
          const title = item.title?.trim() ? item.title.trim() : null;
          const notes = item.notes?.length ? item.notes : null;
          const itemCreatedAt = item.createdAt ?? now;
          // #671: a Stash JSON backup restore carries its own generated
          // metadata snapshot (parseJsonBackup, #678) — restore it losslessly
          // instead of re-fetching. metadata_status is deliberately never
          // 'pending' for a restore (even with no snapshot to restore), so
          // enrichInBackground's pending-only guard naturally no-ops rather
          // than needing a separate skip flag. External imports (HTML/CSV)
          // keep today's client metadata fetch — only automatic AI changes.
          const isBackupRestore = item.source === "stash-backup";
          const restoredMetadata = isBackupRestore ? item.metadata : undefined;
          const description = restoredMetadata?.description ?? null;
          const previewImageUrl = restoredMetadata?.preview_image_url ?? null;
          const faviconUrl = restoredMetadata?.favicon_url ?? null;
          const siteName = restoredMetadata?.site_name ?? null;
          const rawCanonicalUrl = restoredMetadata?.canonical_url?.trim();
          const canonicalUrl =
            isBackupRestore && rawCanonicalUrl && normalizeUrl(rawCanonicalUrl)
              ? normalizeUrl(rawCanonicalUrl)
              : null;
          const contentType: ContentType =
            isBackupRestore &&
              restoredMetadata?.content_type &&
              isContentType(restoredMetadata.content_type)
              ? restoredMetadata.content_type === "image" && !previewImageUrl?.trim()
                ? "url"
                : restoredMetadata.content_type
              : "url";
          const metadataStatus: MetadataStatus = isBackupRestore
            ? restoredMetadata
              ? "complete"
              : "skipped"
            : "pending";
          newBookmarks.push({
            id,
            user_id: mockUserId,
            url: normalized,
            canonical_url: canonicalUrl,
            url_hash: dedupeKey,
            title,
            title_is_derived: title ? false : undefined,
            client_id: clientId,
            description,
            description_format: item.description_format,
            notes_format: item.notes_format,
            notes,
            source_app: null,
            content_type: contentType,
            preview_image_url: previewImageUrl,
            favicon_url: faviconUrl,
            site_name: siteName,
            collection_id: null,
            is_archived: false,
            deleted_at: null,
            created_at: itemCreatedAt,
            updated_at: now,
            last_saved_at: now,
            metadata_status: metadataStatus,
            sync_status: "pending",
          });
          newEntries.push({
            local_id: id,
            remote_id: null,
            operation: "create",
            changes: [{ source: "import", fields: [], at: now }],
            payload: {
              id,
              url: normalized,
              canonical_url: canonicalUrl,
              content_type: contentType,
              title: title ?? undefined,
              notes: notes ?? undefined,
              description_format: item.description_format,
              notes_format: item.notes_format,
              client_id: clientId,
              description: description ?? undefined,
              preview_image_url: previewImageUrl,
              favicon_url: faviconUrl,
              site_name: siteName,
              metadata_status: metadataStatus,
              // #671: never let an imported/restored bookmark auto-spend AI
              // quota — only a fresh save/share gets automatic server-side AI.
              enrichment_policy: "skip",
              created_at: itemCreatedAt,
            },
            sync_status: "pending",
            retry_count: 0,
            last_error: null,
            created_at: now,
            updated_at: now,
          });
          imported += 1;
        }

        for (const tagName of item.tags) {
          const op: PendingTagOp = {
            id: makeUuid(),
            bookmark_id: id,
            tag_name: tagName,
            op: "add",
            source: "user",
            confidence: null,
            created_at: now,
          };
          nextTagData = applyTagOp(nextTagData, op, auth.userId ?? mockUserId);
          nextTagOps = enqueueTagOp(nextTagOps, op);
          organizationChanged = true;
        }
        const collectionName = item.collection?.trim();
        const target = activeBookmarkById.get(id);
        if (collectionName && !target?.collection_id) {
          nextImportCollections = enqueuePendingImportCollection(
            nextImportCollections,
            {
              bookmark_id: id,
              collection_name: collectionName,
              status: "pending",
              last_error: null,
              created_at: now,
            },
          );
          organizationChanged = true;
        }
        // #671: a Stash JSON backup restore carries the bookmark's own AI
        // enrichment snapshot (parseJsonBackup, #678). Queue it durably so a
        // later sync pass restores it losslessly instead of the bookmark
        // going through fresh (paid) AI enrichment. Safe to enqueue even for
        // a dedupe-matched existing bookmark — restoreAIEnrichment's
        // ON-CONFLICT-ignore write never clobbers a real enrichment already
        // there, so the worst case is a harmless no-op upload.
        if (item.source === "stash-backup" && item.enrichment) {
          nextEnrichmentRestores = enqueuePendingEnrichmentRestore(
            nextEnrichmentRestores,
            {
              bookmark_id: id,
              enrichment: item.enrichment,
              status: "pending",
              last_error: null,
              created_at: now,
            },
          );
          organizationChanged = true;
        }
      }

      if (organizationChanged) {
        pendingTagOpsRef.current = nextTagOps;
        setPendingTagOps(nextTagOps);
        tagDataRef.current = nextTagData;
        setTagData(nextTagData);
        pendingImportCollectionsRef.current = nextImportCollections;
        setPendingImportCollections(nextImportCollections);
        pendingEnrichmentRestoresRef.current = nextEnrichmentRestores;
        setPendingEnrichmentRestores(nextEnrichmentRestores);
      }

      if (newBookmarks.length > 0 || organizationChanged) {
        setBookmarks((current) => [...newBookmarks, ...(current ?? [])]);
        setQueue((current) => [...current, ...newEntries]);
        localCreateFlushesInFlight.current += 1;
        // Reserve every imported id in the enriching guard up front: the
        // pending-backfill effect fires on the next render (before the
        // sequential inserts below finish), and an enrichment fetch that beats
        // this row's durable insert would write the enriched row first — only
        // for the later insertBookmark (INSERT OR REPLACE on native) to replace
        // it with the stale pending snapshot (PR #594 review). Each row starts
        // enriching only once its own insert+enqueue has landed, which also
        // keeps the enriched update from being clobbered in the queue table.
        const reserved = new Set(newBookmarks.map((bookmark) => bookmark.id));
        for (const id of reserved) {
          enriching.current.add(id);
        }
        const releaseAndEnrich = (bookmark: Bookmark) => {
          if (reserved.delete(bookmark.id)) {
            enriching.current.delete(bookmark.id);
            enrichInBackground(bookmark);
          }
        };
        void serializeTagWork(async () => {
          await ensureRepositoryReady();
          const epochAtStart = resetEpoch.current;
          if (resetEpoch.current !== epochAtStart) {
            recordLog("warn", "import: loop aborted by library reset");
            return;
          }
          const metaUpdates = organizationChanged
            ? {
              [PENDING_TAG_OPS_KEY]: JSON.stringify(nextTagOps),
              [PENDING_IMPORT_COLLECTIONS_KEY]: JSON.stringify(
                nextImportCollections,
              ),
              [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify(
                nextEnrichmentRestores,
              ),
            }
            : undefined;
          if (repository.insertImportBatch && newBookmarks.length > 0) {
            await repository.insertImportBatch(newBookmarks, newEntries, {
              metaUpdates,
            });
            const ENRICH_BATCH_SIZE = 10;
            for (let i = 0; i < newBookmarks.length; i += ENRICH_BATCH_SIZE) {
              if (resetEpoch.current !== epochAtStart) {
                break;
              }
              const chunk = newBookmarks.slice(i, i + ENRICH_BATCH_SIZE);
              for (const bookmark of chunk) {
                releaseAndEnrich(bookmark);
              }
              if (i + ENRICH_BATCH_SIZE < newBookmarks.length) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
          } else {
            if (metaUpdates) {
              for (const [key, value] of Object.entries(metaUpdates)) {
                await repository.setMeta(key, value);
              }
            }
            for (let i = 0; i < newBookmarks.length; i += 1) {
              if (resetEpoch.current !== epochAtStart) {
                recordLog("warn", "import: loop aborted by library reset");
                break;
              }
              await repository.insertBookmark(newBookmarks[i]);
              await repository.enqueue(newEntries[i]);
              releaseAndEnrich(newBookmarks[i]);
            }
          }
        })
          .catch((error) => logStorageError("imported bookmarks", error))
          .finally(() => {
            localCreateFlushesInFlight.current = Math.max(
              0,
              localCreateFlushesInFlight.current - 1,
            );
            // Rows whose insert never ran (storage failure): still enrich them —
            // they live on in optimistic state, and enrichment must not be lost
            // to a storage error. Nothing durable exists to clobber anyway.
            for (const bookmark of newBookmarks) {
              releaseAndEnrich(bookmark);
            }
            if (localCreateFlushesInFlight.current === 0) {
              syncPendingRef.current = false;
              const pendingForce = syncPendingForceRef.current;
              syncPendingForceRef.current = false;
              setTimeout(() => {
                void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
              }, 50);
            }
          });
      }

      recordLog(
        "info",
        `import: finished items=${items.length} imported=${imported} duplicates=${duplicates} skipped=${skipped}`,
      );
      return { imported, duplicates, skipped };
    },
    [auth.userId, loadedBookmarks, enrichInBackground, isSyncingState, serializeTagWork],
  );
  return { importBookmarks };
}
