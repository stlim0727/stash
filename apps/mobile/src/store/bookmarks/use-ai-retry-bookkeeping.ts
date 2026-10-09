import {
  dropAiEnrichmentDispatchIds,
  remapAiEnrichmentDispatchIds,
  type AiEnrichmentBurstQueue
} from "@/domain/ai-enrichment-burst";
import type {
  Bookmark
} from "@/domain/types";
import { repository } from "@/storage/repository";
import { AI_RETRY_MAX_ATTEMPTS, AI_RETRY_STATE_KEY, AI_SERVER_QUEUED_KEY, PENDING_AI_PREVIEW_REFRESH_KEY, PENDING_AI_TRIGGER_KEY } from '@/store/bookmarks/constants';
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AiRetryState } from '@/store/bookmarks/types';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  pendingAiTrigger: RefObject<Set<string>>;
  pendingAiPreviewRefresh: RefObject<Set<string>>;
  aiRetryState: RefObject<Record<string, AiRetryState>>;
  setAiRetryIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  deletedIds: RefObject<Set<string>>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  aiServerQueued: RefObject<Set<string>>;
  setAiServerQueuedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  aiTriggerAttempted: RefObject<Set<string>>;
  aiDispatchQueueRef: RefObject<AiEnrichmentBurstQueue>;
}

export function useAiRetryBookkeeping({
  pendingAiTrigger,
  pendingAiPreviewRefresh,
  aiRetryState,
  setAiRetryIds,
  deletedIds,
  bookmarksRef,
  aiServerQueued,
  setAiServerQueuedIds,
  aiTriggerAttempted,
  aiDispatchQueueRef,
}: Dependencies) {

  // Mirror the deferred AI-trigger set to durable meta after a ref mutation.
  // Returns the write's promise (always resolves — errors are logged, not
  // thrown) so a caller that needs true ordering (e.g. requestAiEnrichment's
  // catch, see armAiRetry below) can await it to completion rather than
  // firing it and moving on.
  const persistPendingAiTrigger = useCallback((): Promise<void> => {
    const ids = [...pendingAiTrigger.current];
    return ensureRepositoryReady()
      .then(() =>
        repository.setMeta(PENDING_AI_TRIGGER_KEY, JSON.stringify(ids)),
      )
      .catch((error) => logStorageError("ai trigger queue", error));
  }, []);
  const markPendingAiTrigger = useCallback(
    (id: string) => {
      pendingAiTrigger.current.add(id);
      persistPendingAiTrigger();
    },
    [persistPendingAiTrigger],
  );
  const clearPendingAiTrigger = useCallback(
    (id: string): Promise<void> => {
      if (pendingAiTrigger.current.delete(id)) {
        return persistPendingAiTrigger();
      }
      return Promise.resolve();
    },
    [persistPendingAiTrigger],
  );
  const persistPendingAiPreviewRefresh = useCallback((): Promise<void> => {
    return ensureRepositoryReady()
      .then(() =>
        repository.setMeta(
          PENDING_AI_PREVIEW_REFRESH_KEY,
          JSON.stringify([...pendingAiPreviewRefresh.current]),
        ),
      )
      .catch((error) => logStorageError("preview AI refresh queue", error));
  }, []);
  const markPendingAiPreviewRefresh = useCallback(
    (id: string) => {
      pendingAiPreviewRefresh.current.add(id);
      void persistPendingAiPreviewRefresh();
    },
    [persistPendingAiPreviewRefresh],
  );
  const clearPendingAiPreviewRefresh = useCallback(
    (id: string) => {
      if (pendingAiPreviewRefresh.current.delete(id)) {
        void persistPendingAiPreviewRefresh();
      }
    },
    [persistPendingAiPreviewRefresh],
  );

  // Write aiRetryState.current to durable storage, rejecting (rather than
  // swallowing) on failure. Only armAiRetry uses this directly — its caller
  // (requestAiEnrichment's catch) must know whether the write actually landed
  // before it clears the pending-trigger marker (see armAiRetry below). Every
  // other caller goes through persistAiRetryState, which keeps swallowing.
  const writeAiRetryState = useCallback((): Promise<void> => {
    return ensureRepositoryReady().then(() =>
      repository.setMeta(
        AI_RETRY_STATE_KEY,
        JSON.stringify(aiRetryState.current),
      ),
    );
  }, []);

  // Persist the AI-retry bookkeeping map after a ref mutation (mirrors
  // persistPendingAiTrigger). Does NOT touch React state — callers update the
  // reactive `aiRetryIds` mirror themselves via `syncAiRetryIds`, at the point
  // that's safe for their caller (see requestAiEnrichment's `finally`).
  // Returns the write's promise for the same reason persistPendingAiTrigger
  // does.
  const persistAiRetryState = useCallback((): Promise<void> => {
    return writeAiRetryState().catch((error) =>
      logStorageError("ai retry state", error),
    );
  }, [writeAiRetryState]);

  // Refresh the reactive mirror of aiRetryState's keys. Called once per
  // settled requestAiEnrichment call (from its `finally`) rather than
  // immediately inside armAiRetry/clearAiRetry, so it always lands in the same
  // synchronous block as the isEnriching flip — never a frame earlier.
  const syncAiRetryIds = useCallback(() => {
    setAiRetryIds(new Set(Object.keys(aiRetryState.current)));
  }, []);

  // Arm (or re-arm) a bookmark's retry marker after a requestAiEnrichment
  // failure (auto or manual) that wrote no ai_enrichments row. Exhausting
  // AI_RETRY_MAX_ATTEMPTS clears the marker entirely instead of leaving a
  // distinct "gave up" state, so the bookmark reverts to looking exactly like
  // one that was never enriched. Local-only: never touches the bookmark row,
  // updated_at, or the sync queue.
  // Returns whether the retry-state write actually landed on disk (unlike
  // persistAiRetryState, this one doesn't swallow failures) so a caller that
  // must not clear a different durable marker until this write is confirmed
  // — see requestAiEnrichment's catch below — can gate on it instead of
  // assuming success.
  const armAiRetry = useCallback(
    (bookmarkId: string): Promise<boolean> => {
      // The request that just failed can have been in flight when the user
      // trashed or permanently deleted this bookmark — trashBookmark/
      // deleteBookmark already clear an EXISTING marker synchronously at that
      // moment, but can't stop a failure that lands afterward from re-arming
      // it. Re-arming here would let a later backoff-scheduled retry silently
      // write fresh AI suggestions for content the user already discarded (or,
      // for a hard delete, fire a doomed request against an id that no longer
      // exists). Skip arming once there's positive evidence of either.
      if (deletedIds.current.has(bookmarkId)) {
        return Promise.resolve(true);
      }
      const forBookmark = bookmarksRef.current?.find(
        (item) => item.id === bookmarkId,
      );
      if (forBookmark?.deleted_at) {
        return Promise.resolve(true);
      }
      const now = new Date().toISOString();
      const existing = aiRetryState.current[bookmarkId];
      const attemptCount = (existing?.attemptCount ?? 0) + 1;
      const next = { ...aiRetryState.current };
      if (attemptCount >= AI_RETRY_MAX_ATTEMPTS) {
        delete next[bookmarkId];
      } else {
        next[bookmarkId] = {
          firstAttemptAt: existing?.firstAttemptAt ?? now,
          lastAttemptAt: now,
          attemptCount,
        };
      }
      aiRetryState.current = next;
      return writeAiRetryState().then(
        () => true,
        (error) => {
          logStorageError("ai retry state", error);
          return false;
        },
      );
    },
    [writeAiRetryState],
  );

  // An unfile mutation intentionally has an empty queue payload, so a pending
  // entry cannot tell us which field changed. Keep a zero-attempt durable
  // marker while waiting for sync instead of spending a provider-failure retry.
  const deferAiEnrichmentUntilSync = useCallback(
    (bookmarkId: string) => {
      if (deletedIds.current.has(bookmarkId)) {
        return;
      }
      const existing = aiRetryState.current[bookmarkId];
      if (existing && existing.attemptCount > 0) {
        return;
      }
      const now = new Date().toISOString();
      aiRetryState.current = {
        ...aiRetryState.current,
        [bookmarkId]: {
          firstAttemptAt: existing?.firstAttemptAt ?? now,
          lastAttemptAt: now,
          attemptCount: 0,
        },
      };
      persistAiRetryState();
      syncAiRetryIds();
    },
    [persistAiRetryState, syncAiRetryIds],
  );

  // Clear a bookmark's retry marker after a successful attempt.
  const clearAiRetry = useCallback(
    (bookmarkId: string) => {
      if (!(bookmarkId in aiRetryState.current)) {
        return;
      }
      const next = { ...aiRetryState.current };
      delete next[bookmarkId];
      aiRetryState.current = next;
      persistAiRetryState();
    },
    [persistAiRetryState],
  );

  // Mirror the confirmed-server-queued set to durable meta after a ref
  // mutation (mirrors persistPendingAiTrigger). Swallows failures — nothing
  // downstream needs to gate on this write landing the way armAiRetry's
  // caller gates on writeAiRetryState.
  const persistAiServerQueued = useCallback((): Promise<void> => {
    const ids = [...aiServerQueued.current];
    return ensureRepositoryReady()
      .then(() => repository.setMeta(AI_SERVER_QUEUED_KEY, JSON.stringify(ids)))
      .catch((error) => logStorageError("ai server-queued", error));
  }, []);

  // Refresh the reactive mirror of aiServerQueued's members.
  const syncAiServerQueuedIds = useCallback(() => {
    setAiServerQueuedIds(new Set(aiServerQueued.current));
  }, []);

  // Mark a bookmark as CONFIRMED accepted into the server-side overflow
  // queue. Callers must only invoke this once the enqueue POST itself has
  // resolved — never eagerly, and never on a rejected or synchronously-thrown
  // enqueue attempt (those fall back to the generic armAiRetry treatment
  // alone; see requestAiEnrichment's 429 branch). Fire-and-forget, like the
  // enqueue call site itself — must never block or throw into that path.
  const markAiServerQueued = useCallback(
    (bookmarkId: string) => {
      aiServerQueued.current.add(bookmarkId);
      persistAiServerQueued();
      syncAiServerQueuedIds();
    },
    [persistAiServerQueued, syncAiServerQueuedIds],
  );

  // Clear a bookmark's confirmed-server-queued marker once a real enrichment
  // actually lands for it, or it's discarded. No-op if absent, mirroring
  // clearAiRetry's early return.
  const clearAiServerQueued = useCallback(
    (bookmarkId: string) => {
      if (!aiServerQueued.current.delete(bookmarkId)) {
        return;
      }
      persistAiServerQueued();
      syncAiServerQueuedIds();
    },
    [persistAiServerQueued, syncAiServerQueuedIds],
  );

  // Drop this (previous) account's AI-suggestion bookkeeping for the given
  // ids — mirrors dropPendingTagOpsForBookmarks's purpose for tag state.
  // Without this, a real A→real B switch (or logout) leaves A's
  // aiRetryState/pendingAiTrigger entries in place, and checkAiRetries (or
  // the deferred first-trigger effect) has no ownership check: it would fire
  // requestAiEnrichment for A's bookmark id under B's now-active session.
  const dropAiRetryBookkeeping = useCallback(
    (ids: readonly string[]) => {
      let retryChanged = false;
      const nextRetry = { ...aiRetryState.current };
      let serverQueuedChanged = false;
      for (const id of ids) {
        if (id in nextRetry) {
          delete nextRetry[id];
          retryChanged = true;
        }
        // The confirmed-server-queued marker is account-scoped bookkeeping
        // just like aiRetryState/pendingAiTrigger above — drop it too, so a
        // dropped account's stale queue confirmation can't linger and show a
        // "queued" note under the next (different) session.
        if (aiServerQueued.current.delete(id)) {
          serverQueuedChanged = true;
        }
        pendingAiTrigger.current.delete(id);
        pendingAiPreviewRefresh.current.delete(id);
        aiTriggerAttempted.current.delete(id);
      }
      // The staggered auto-dispatch queue is account-scoped bookkeeping too:
      // a bookmark staged here but not yet popped when the account switched
      // otherwise keeps counting toward the new session's pipeline total
      // (Sentry STASH-4Y).
      aiDispatchQueueRef.current = dropAiEnrichmentDispatchIds(
        aiDispatchQueueRef.current,
        ids,
      );
      if (retryChanged) {
        aiRetryState.current = nextRetry;
        persistAiRetryState();
        syncAiRetryIds();
      }
      if (serverQueuedChanged) {
        persistAiServerQueued();
        syncAiServerQueuedIds();
      }
      persistPendingAiTrigger();
      persistPendingAiPreviewRefresh();
    },
    [
      persistAiRetryState,
      syncAiRetryIds,
      persistPendingAiTrigger,
      persistAiServerQueued,
      syncAiServerQueuedIds,
      persistPendingAiPreviewRefresh,
    ],
  );

  // Re-key this account's AI-suggestion bookkeeping (aiRetryState,
  // pendingAiTrigger, aiTriggerAttempted) from an old bookmark id onto its
  // new one — mirrors rekeyPendingTagOps's purpose for tag state. The only
  // caller is the anon→real carry-over rehome (a bookmark's id is otherwise
  // stable for life once captured — see makeBookmarkId). Without this, a
  // re-keyed bookmark silently loses retry eligibility and its stale old-id
  // entry becomes an orphan that fires against an id that no longer exists.
  //
  // aiTriggerAttempted is deliberately NOT carried onto newId — only removed
  // from oldId. It's a session-only in-memory "already fired this launch"
  // dedupe marker (see its declaration), so its only valid purpose is
  // preventing a same-session re-fire of the SAME still-pending trigger for
  // the SAME identity. Carrying it forward doesn't protect anything: an
  // in-flight request still keyed to oldId targets a row/account that no
  // longer exists under this identity and just fails benignly, while newId
  // typically gets a brand-new `markPendingAiTrigger` call immediately after
  // the rehome — carrying the "already attempted" flag onto that fresh
  // identity made the deferred-trigger effect
  // (`aiTriggerAttempted.current.has(id)`) skip it forever this session, so
  // the re-keyed bookmark silently never got AI suggestions until an app
  // restart cleared the in-memory set.
  const remapAiRetryIdentity = useCallback(
    (idMap: ReadonlyMap<string, string>) => {
      let retryChanged = false;
      const nextRetry = { ...aiRetryState.current };
      for (const [oldId, newId] of idMap) {
        if (oldId in nextRetry) {
          nextRetry[newId] = nextRetry[oldId];
          delete nextRetry[oldId];
          retryChanged = true;
        }
      }
      if (retryChanged) {
        aiRetryState.current = nextRetry;
        persistAiRetryState();
        syncAiRetryIds();
      }
      // Re-key the confirmed-server-queued marker the same way — without
      // this, a bookmark whose 429 was already confirmed queued would lose
      // that confirmation the moment an id swap (rehome, create-upload
      // remote-id swap, crash-safe reconciliation) parks it under a new id.
      let serverQueuedChanged = false;
      for (const [oldId, newId] of idMap) {
        if (aiServerQueued.current.delete(oldId)) {
          aiServerQueued.current.add(newId);
          serverQueuedChanged = true;
        }
      }
      if (serverQueuedChanged) {
        persistAiServerQueued();
        syncAiServerQueuedIds();
      }
      let triggerChanged = false;
      for (const [oldId, newId] of idMap) {
        if (pendingAiTrigger.current.delete(oldId)) {
          pendingAiTrigger.current.add(newId);
          triggerChanged = true;
        }
        aiTriggerAttempted.current.delete(oldId);
      }
      if (triggerChanged) {
        persistPendingAiTrigger();
      }
      let previewRefreshChanged = false;
      for (const [oldId, newId] of idMap) {
        if (pendingAiPreviewRefresh.current.delete(oldId)) {
          pendingAiPreviewRefresh.current.add(newId);
          previewRefreshChanged = true;
        }
      }
      if (previewRefreshChanged) {
        persistPendingAiPreviewRefresh();
      }
      // Re-key the staggered auto-dispatch burst queue too — without this, a
      // bookmark staged here under its old anonymous id silently no-ops the
      // moment the drain loop pops it: `requestAiEnrichment`'s first check
      // (`bookmarksRef.current?.some(item => item.id === bookmarkId)`) finds
      // nothing under the now-dead old id, and the queued auto-suggestion is
      // lost rather than delivered under the new one (#692).
      aiDispatchQueueRef.current = remapAiEnrichmentDispatchIds(
        aiDispatchQueueRef.current,
        idMap,
      );
    },
    [
      persistAiRetryState,
      syncAiRetryIds,
      persistPendingAiTrigger,
      persistAiServerQueued,
      syncAiServerQueuedIds,
      persistPendingAiPreviewRefresh,
    ],
  );
  return { persistPendingAiTrigger, markPendingAiTrigger, clearPendingAiTrigger, persistPendingAiPreviewRefresh, markPendingAiPreviewRefresh, clearPendingAiPreviewRefresh, writeAiRetryState, persistAiRetryState, syncAiRetryIds, armAiRetry, deferAiEnrichmentUntilSync, clearAiRetry, persistAiServerQueued, syncAiServerQueuedIds, markAiServerQueued, clearAiServerQueued, dropAiRetryBookkeeping, remapAiRetryIdentity };
}
