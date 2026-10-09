import type {
  EnrichmentMetadataHint
} from "@/api/bookmarks";
import {
  AI_ENRICHMENT_BURST_TOAST_MIN,
  AI_ENRICHMENT_DISPATCH_STAGGER_MS,
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  clearBurstCompletion,
  dequeueAiEnrichmentDispatch,
  enqueueAiEnrichmentDispatch,
  isBurstComplete,
  recordAiEnrichmentDispatchSettled,
  type AiEnrichmentBurstQueue
} from "@/domain/ai-enrichment-burst";
import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import {
  type AiServerQueueSnapshot
} from "@/domain/processing-status";
import type {
  Bookmark, LocalPendingBookmark
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import { registerForForegroundState } from "@/storage/sqlite-app-lifecycle";
import { AI_RETRY_BACKOFF_MS, AI_RETRY_CHECK_INTERVAL_MS, AI_SERVER_QUEUED_STATUS_CHUNK_SIZE } from '@/store/bookmarks/constants';
import { type AiRetryState } from '@/store/bookmarks/types';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import {
  createSyncApi
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback,
  useEffect,
  useRef
} from "react";

interface Dependencies {
  auth: ReturnType<typeof useSupabaseAuth>;
  aiSuggestionsModeRef: RefObject<AiSuggestionsMode>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  aiRetryState: RefObject<Record<string, AiRetryState>>;
  aiEnriching: RefObject<Set<string>>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  aiDispatchQueueRef: RefObject<AiEnrichmentBurstQueue>;
  requestAiEnrichment: (bookmarkId: string, source?: "auto" | "manual" | "preview", overrideMetadata?: EnrichmentMetadataHint) => Promise<string | null>;
  checkAiRetriesRef: RefObject<(() => void) | null>;
  setAiQuotaExceeded: Dispatch<SetStateAction<{ reason: string; retryAt: number; } | null>>;
  aiDispatchInFlight: RefObject<boolean>;
  aiQuotaCooldownUntil: RefObject<number>;
  bulkReconcileInFlight: RefObject<number>;
  aiDispatchEpoch: RefObject<number>;
  clearPendingAiTrigger: (id: string) => Promise<void>;
  aiBurstTokenSeq: RefObject<number>;
  setAiEnrichmentBurstToast: Dispatch<SetStateAction<{ count: number; token: number; } | null>>;
  bookmarks: Bookmark[] | null;
  aiServerQueued: RefObject<Set<string>>;
  persistAiServerQueued: () => Promise<void>;
  syncAiServerQueuedIds: () => void;
  setAiServerQueueSnapshot: Dispatch<SetStateAction<readonly AiServerQueueSnapshot[] | null>>;
}

export function useAiRetryLifecycle({
  auth,
  aiSuggestionsModeRef,
  queueRef,
  aiRetryState,
  aiEnriching,
  bookmarksRef,
  aiDispatchQueueRef,
  requestAiEnrichment,
  checkAiRetriesRef,
  setAiQuotaExceeded,
  aiDispatchInFlight,
  aiQuotaCooldownUntil,
  bulkReconcileInFlight,
  aiDispatchEpoch,
  clearPendingAiTrigger,
  aiBurstTokenSeq,
  setAiEnrichmentBurstToast,
  bookmarks,
  aiServerQueued,
  persistAiServerQueued,
  syncAiServerQueuedIds,
  setAiServerQueueSnapshot,
}: Dependencies) {

  // Backoff-scheduled AI-suggestion retries: re-attempt any bookmark with an
  // armed retry marker (a prior auto OR manual requestAiEnrichment failure)
  // once enough wall-clock time has passed since its last attempt (see
  // AI_RETRY_BACKOFF_MS). Reads aiRetryState directly (the ref, not the
  // reactive mirror) so it always sees the latest bookkeeping. STASH #573:
  // no-ops entirely when the mode is 'off'.
  const checkAiRetries = useCallback(() => {
    if (!auth.session || aiSuggestionsModeRef.current === "off") {
      return;
    }
    if (
      queueRef.current.some(
        (entry) =>
          entry.sync_status === "pending" || entry.sync_status === "syncing",
      )
    ) {
      return;
    }
    const now = Date.now();
    for (const [id, state] of Object.entries(aiRetryState.current)) {
      if (aiEnriching.current.has(id)) {
        continue; // a retry (or a manual tap) is already in flight for this id
      }
      const current = bookmarksRef.current?.find((item) => item.id === id);
      if (!current) {
        continue;
      }
      // If this bookmark has unsynced work (e.g. pending/failed folder move),
      // defer retry until sync succeeds so we don't dispatch against stale cloud state
      // or churn the AI retry budget (STASH-74 / Codex catch).
      const hasUnsyncedWork =
        queueRef.current.some((entry) => entry.local_id === id) ||
        current.sync_status !== "synced";
      if (hasUnsyncedWork) {
        continue;
      }
      const waitMs = AI_RETRY_BACKOFF_MS[state.attemptCount];
      if (waitMs === undefined) {
        continue; // defensive: the cap already clears entries before this can happen
      }
      if (now - new Date(state.lastAttemptAt).getTime() < waitMs) {
        continue; // backoff not yet elapsed
      }
      // STASH #574 Phase 1: queue for staggered dispatch (see the deferred
      // auto AI enrichment effect above for why).
      aiDispatchQueueRef.current = enqueueAiEnrichmentDispatch(
        aiDispatchQueueRef.current,
        id,
      );
    }
  }, [auth.session, requestAiEnrichment]);
  checkAiRetriesRef.current = checkAiRetries;

  // STASH #574 Phase 1: drains aiDispatchQueueRef at a steady stagger, calling
  // requestAiEnrichment for one queued id at a time instead of a whole burst
  // firing simultaneously. Both producers above (the deferred first-trigger
  // effect and checkAiRetries) only enqueue; this is the one place that
  // actually dispatches, so it's also the one place that knows when a burst
  // has fully drained — which is what decides whether the completion toast is
  // worth showing.
  useEffect(() => {
    if (!auth.session) {
      return;
    }
    const interval = setInterval(() => {
      // Display-only cleanup, independent of the mode/dispatch gating below:
      // once the server-accurate reset time has passed, stop telling Settings
      // and feedback diagnostics the quota is still exceeded. A future 429
      // (if the wait wasn't actually over, or a fresh burst re-exhausts it)
      // re-arms this the same way.
      setAiQuotaExceeded((current) =>
        current && Date.now() >= current.retryAt ? null : current,
      );
      if (aiSuggestionsModeRef.current === "off") {
        // Mode flipped off mid-burst: drop whatever's left rather than keep
        // firing requests for a feature the user just turned off.
        aiDispatchQueueRef.current = EMPTY_AI_ENRICHMENT_BURST_QUEUE;
        return;
      }
      if (aiDispatchInFlight.current) {
        return; // still waiting on the previous dispatch to settle
      }
      if (Date.now() < aiQuotaCooldownUntil.current) {
        // STASH-4K follow-up: the quota is known exhausted (armed by a
        // recent 429) — leave the queue as-is (unlike the mode==='off'
        // branch above, this isn't abandoned work) and simply wait out the
        // cooldown instead of dispatching into more guaranteed rejections.
        return;
      }
      if (
        queueRef.current.some(
          (entry) =>
            entry.sync_status === "pending" || entry.sync_status === "syncing",
        )
      ) {
        return; // let bookmark sync settle before starting AI work for freshly-created rows
      }
      if (bulkReconcileInFlight.current > 0) {
        // A bulk-create chunk's reconcile follow-up can leave the queue
        // with nothing pending/syncing for a window that outlasts this
        // interval's own tick (its writes now genuinely await SQLite calls
        // in sequence) — without this, that gap looks like "sync settled"
        // and this would start firing AI requests during the exact SQLite
        // stall the STASH-3Y fix is meant to relieve (caught in PR review).
        return;
      }
      const { queue, id } = dequeueAiEnrichmentDispatch(
        aiDispatchQueueRef.current,
      );
      aiDispatchQueueRef.current = queue;
      if (!id) {
        return;
      }
      aiDispatchInFlight.current = true;
      const dispatchEpochAtStart = aiDispatchEpoch.current;
      void requestAiEnrichment(id, "auto")
        .then((error) => {
          if (!error) {
            void clearPendingAiTrigger(id);
          }
        })
        .finally(() => {
          aiDispatchInFlight.current = false;
          if (aiDispatchEpoch.current !== dispatchEpochAtStart) {
            // An account boundary was crossed while this dispatch was in
            // flight — aiDispatchQueueRef now belongs to a different
            // session; discard rather than count this settle toward its
            // burst total (#691).
            return;
          }
          aiDispatchQueueRef.current = recordAiEnrichmentDispatchSettled(
            aiDispatchQueueRef.current,
          );
          if (isBurstComplete(aiDispatchQueueRef.current)) {
            const completed = aiDispatchQueueRef.current.completedInBurst;
            aiDispatchQueueRef.current = clearBurstCompletion(
              aiDispatchQueueRef.current,
            );
            if (completed >= AI_ENRICHMENT_BURST_TOAST_MIN) {
              aiBurstTokenSeq.current += 1;
              setAiEnrichmentBurstToast({
                count: completed,
                token: aiBurstTokenSeq.current,
              });
            }
          }
        });
    }, AI_ENRICHMENT_DISPATCH_STAGGER_MS);
    return () => clearInterval(interval);
  }, [auth.session, requestAiEnrichment, clearPendingAiTrigger]);

  // Cold-launch retry check: once storage has loaded and auth is ready, run
  // the backoff check once so a bookmark whose wait already elapsed while the
  // app was closed retries immediately rather than waiting for the next
  // foreground transition or periodic tick.
  const coldLaunchRetryChecked = useRef(false);
  useEffect(() => {
    if (bookmarks === null || !auth.session || coldLaunchRetryChecked.current) {
      return;
    }
    coldLaunchRetryChecked.current = true;
    checkAiRetries();
  }, [bookmarks, auth.session, checkAiRetries]);

  // Foreground-transition + periodic retry check: re-run the backoff check
  // whenever the app returns to the foreground, and (while foregrounded) every
  // AI_RETRY_CHECK_INTERVAL_MS so a bookmark isn't stuck waiting for the next
  // background/foreground cycle if the app is simply left open for hours.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(checkAiRetries, AI_RETRY_CHECK_INTERVAL_MS);
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        checkAiRetries();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [checkAiRetries]);

  // Reconcile aiServerQueued against the queue's real remote status (Codex
  // review, PR #656). Unlike checkAiRetries, this deliberately does NOT gate
  // on aiSuggestionsMode === "off": the overflow worker keeps processing
  // already-queued rows server-side regardless of the local dispatch/retry
  // pause, so this must keep running too — it's reading server truth, not
  // driving new dispatch. A row the worker gave up on (status: 'failed', past
  // MAX_ENRICHMENT_ATTEMPTS) or that no longer exists (a deleted bookmark
  // cascades its row away) never produces an ai_enrichments row, so without
  // this clearAiServerQueued's only trigger (a real enrichment landing via
  // sync) would never fire for it — the local marker, and the "still queued"
  // backlog count it drives, would say so forever for a bookmark that will in
  // fact never complete.
  const reconcileAiServerQueued = useCallback(() => {
    const session = auth.session;
    const ids = [...aiServerQueued.current];
    if (!session || ids.length === 0) {
      return;
    }
    const api = createSyncApi(session);
    // Bounded chunks (Codex review, PR #660): a bulk-import-sized backlog
    // (500+ confirmed-queued ids) in one `bookmark_id=in.(...)` query target
    // runs well into tens of KB, which common HTTP gateways reject as
    // URI-too-long — the failed request would then just retry itself
    // unchanged every tick, forever unable to reconcile anything.
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += AI_SERVER_QUEUED_STATUS_CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + AI_SERVER_QUEUED_STATUS_CHUNK_SIZE));
    }
    Promise.all(
      chunks.map((chunk) => api.fetchPendingEnrichmentStatuses(chunk)),
    )
      .then((results) => {
        const statusById = new Map(
          results.flat().map((row) => [row.bookmark_id, row.status]),
        );
        // Batch removal: mutate the ref directly and persist/sync the mirror
        // ONCE for the whole pass, instead of once per terminal id via
        // clearAiServerQueued. A device returning after many rows failed or
        // disappeared would otherwise fan that many separate native setMeta
        // writes onto the single-connection SQLite actor — the documented
        // tail-wait contention pattern (STASH-3B, -3N, -3Y; see
        // docs/architecture/sqlite-write-contention.md), which recurs
        // whenever a loop persists once per item instead of once per batch
        // (Codex review, PR #660).
        let removedAny = false;
        for (const id of ids) {
          const status = statusById.get(id);
          // 'done' is terminal too, alongside 'failed'/missing: a later 429
          // against a bookmark whose pending_ai_enrichment row the worker
          // already finished resolves via enqueuePendingEnrichment's
          // ignore-duplicates without reviving that row, so the worker will
          // never revisit it and — since the existing ai_enrichments row is
          // unchanged, not newer — no pull will ever clear this marker the
          // normal way either (Codex review, PR #660).
          if (
            status === undefined ||
            status === "failed" ||
            status === "done"
          ) {
            if (aiServerQueued.current.delete(id)) {
              removedAny = true;
            }
          }
        }
        if (removedAny) {
          persistAiServerQueued();
          syncAiServerQueuedIds();
        }
      })
      .catch((error: unknown) => {
        recordLog(
          "warn",
          `pending_ai_enrichment status reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, [auth.session, persistAiServerQueued, syncAiServerQueuedIds]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(
        reconcileAiServerQueued,
        AI_RETRY_CHECK_INTERVAL_MS,
      );
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        reconcileAiServerQueued();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [reconcileAiServerQueued]);

  // Account-wide AI overflow snapshot (fixes the Settings AI counter reading
  // 0 while the server-side worker is actively
  // draining a real backlog it never learned about — e.g. a direct
  // `pending_ai_enrichment` backfill, another device's 429, or the
  // server-side dispatch trigger). Purely a diagnostic/display read: never
  // throws, never blocks anything, and on failure just leaves the last known
  // value in place rather than blanking an already-correct display.
  const fetchAiServerQueueSnapshot = useCallback(async () => {
    if (!auth.session) {
      return;
    }
    // Diagnostic/display-only, but reuses the same "ensure a fresh token
    // first" pattern as syncNow/requestAiEnrichment (rather than trusting the
    // possibly-stale reactive `auth.session` directly) — a soon-to-expire
    // token would otherwise just fail this GET for no reason. Wrapped in
    // try/catch so neither the ensure call nor the fetch itself can ever
    // throw out of this fire-and-forget helper.
    try {
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      if (!session) {
        return;
      }
      const snapshot = await createSyncApi(session).fetchAiQueueSnapshot();
      setAiServerQueueSnapshot(snapshot);
    } catch (error) {
      recordLog(
        "warn",
        `AI server queue snapshot fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [auth]);

  // Same foreground + periodic-tick shape as checkAiRetries/
  // reconcileAiServerQueued above — reuses AI_RETRY_CHECK_INTERVAL_MS rather
  // than a new interval constant, since this is the same class of "keep a
  // background diagnostic in sync every few minutes" work.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(
        fetchAiServerQueueSnapshot,
        AI_RETRY_CHECK_INTERVAL_MS,
      );
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        void fetchAiServerQueueSnapshot();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [fetchAiServerQueueSnapshot]);
  return { checkAiRetries, fetchAiServerQueueSnapshot };
}
