import type {
  AIEnrichment,
  Bookmark,
  LocalPendingBookmark,
  QueueOperation,
} from "./types";
import { isTransientSyncFailure } from "./network-errors.ts";

export type AiServerQueueStatus = "pending" | "processing" | "failed";

export interface AiServerQueueSnapshot {
  bookmark_id: string;
  status: AiServerQueueStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface ProcessingStats {
  remaining: number;
  stages: {
    cloud: number;
    metadata: number;
    ai: number;
    attention: number;
  };
  details: {
    sync: {
      pending: number;
      syncing: number;
      failed: number;
      operations: Record<QueueOperation, number>;
      maxRetries: number;
      oldestCreatedAt: string | null;
    };
    metadata: {
      pending: number;
      failed: number;
      skipped: number;
    };
    ai: {
      trigger: number;
      dispatch: number;
      retry: number;
      inFlight: number;
      serverPending: number;
      serverProcessing: number;
      serverFailed: number;
      degradedRateLimited: number;
    };
  };
  /** Raw, non-exclusive pipeline totals for Developer-mode diagnostics — unlike
   *  `stages`, a bookmark can count in more than one of these at once. Kept on
   *  this same result (rather than a second, separately-computed object) so the
   *  Settings summary and the developer diagnostics can never drift out of sync
   *  with each other. */
  diagnostics: {
    sync: { todo: number; done: number; syncedOnce: number; syncingTwice: number };
    metadata: { todo: number; done: number };
    ai: {
      todo: number;
      done: number;
      serverQueued: number;
      activeUnblocked: number;
      activeBlocked: number;
      /** Completed enrichments that fell back to the heuristic provider
       *  because the Gemini provider itself hit RESOURCE_EXHAUSTED
       *  (`degraded_reason === 'rate_limited'`) — the server auto-requeues
       *  these into `pending_ai_enrichment` for a real-model retry, so this
       *  count is "basic suggestions shown, better ones coming shortly", not
       *  a stuck state. Deliberately excludes `timeout`/`provider_error`/
       *  `not_configured`: only `rate_limited` gets that automatic requeue
       *  (`supabase/functions/ai-enrich/index.ts`), so the others carry no
       *  such promise. */
      degradedRateLimited: number;
    };
  };
}

interface BuildProcessingStatsInput {
  bookmarks: readonly Bookmark[];
  queue: readonly LocalPendingBookmark[];
  enrichments: readonly AIEnrichment[];
  pendingAiTriggerIds: ReadonlySet<string>;
  aiDispatchIds: ReadonlySet<string>;
  aiRetryIds: ReadonlySet<string>;
  aiInFlightIds: ReadonlySet<string>;
  locallyConfirmedServerAiIds: ReadonlySet<string>;
  serverAiQueue: readonly AiServerQueueSnapshot[];
  permanentlyUnsyncableIds?: ReadonlySet<string>;
  /** The sync pipeline's `diagnostics.sync` figures, precomputed by the caller:
   *  they depend on `isSyncable`'s backoff-timing and `isBookmarkSyncedOnce`'s
   *  remote-identity check, both outside domain/'s pure, platform-free scope. */
  syncDiagnostics?: { todo: number; done: number; syncedOnce: number; syncingTwice: number };
}

function without(ids: ReadonlySet<string>, excluded: ReadonlySet<string>): Set<string> {
  return new Set([...ids].filter((id) => !excluded.has(id)));
}

function union(...sets: ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

/**
 * Projects the concurrent sync/metadata/AI statechart into mutually-exclusive
 * Settings stages. The precedence is deliberate: a bookmark that is both
 * upload-pending and metadata-pending reads as "Saving to cloud", while a
 * failed outbox/server job reads as "Needs attention" rather than pretending
 * to still be progressing.
 */
export function buildProcessingStats(input: BuildProcessingStatsInput): ProcessingStats {
  const activeBookmarks = input.bookmarks.filter(
    (bookmark) => bookmark.deleted_at === null && !bookmark.is_archived,
  );
  const activeQueue = input.queue.filter((entry) => entry.sync_status !== "synced");
  const permanentIds = input.permanentlyUnsyncableIds ?? new Set<string>();

  const syncAttentionIds = new Set(
    activeQueue
      .filter(
        (entry) =>
          entry.sync_status === "failed" &&
          !isTransientSyncFailure(entry) &&
          !permanentIds.has(entry.local_id),
      )
      .map((entry) => entry.local_id),
  );
  const cloudCandidateIds = new Set(
    activeQueue
      .filter(
        (entry) =>
          (entry.sync_status === "pending" ||
            entry.sync_status === "syncing" ||
            isTransientSyncFailure(entry)) &&
          !permanentIds.has(entry.local_id) &&
          !syncAttentionIds.has(entry.local_id),
      )
      .map((entry) => entry.local_id),
  );

  const enrichmentIds = new Set(input.enrichments.map((row) => row.bookmark_id));
  const unresolvedServerFailedIds = new Set(
    input.serverAiQueue
      .filter((row) => row.status === "failed" && !enrichmentIds.has(row.bookmark_id))
      .map((row) => row.bookmark_id),
  );
  const attentionIds = union(syncAttentionIds, unresolvedServerFailedIds);
  const cloudIds = without(cloudCandidateIds, attentionIds);

  const metadataCandidateIds = new Set(
    activeBookmarks
      .filter((bookmark) => bookmark.metadata_status === "pending")
      .map((bookmark) => bookmark.id),
  );
  const metadataIds = without(metadataCandidateIds, union(attentionIds, cloudIds));

  const serverAiActiveIds = new Set(
    input.serverAiQueue
      .filter((row) => row.status === "pending" || row.status === "processing")
      .map((row) => row.bookmark_id),
  );
  const aiCandidateIds = union(
    input.pendingAiTriggerIds,
    input.aiDispatchIds,
    input.aiRetryIds,
    input.aiInFlightIds,
    input.locallyConfirmedServerAiIds,
    serverAiActiveIds,
  );
  const aiIds = without(aiCandidateIds, union(attentionIds, cloudIds, metadataIds));

  const serverBacklogIds = union(input.locallyConfirmedServerAiIds, serverAiActiveIds);
  // Deliberately excludes `aiInFlightIds`: this is a queued-only backlog
  // figure (not yet dispatched), distinct from `aiCandidateIds` above, which
  // is used for the user-facing `stages.ai` bucket and does include in-flight
  // requests.
  const aiQueuedOnlyIds = union(
    input.pendingAiTriggerIds,
    input.aiDispatchIds,
    input.aiRetryIds,
    input.locallyConfirmedServerAiIds,
    serverAiActiveIds,
  );
  const degradedRateLimited = input.enrichments.filter(
    (row) => row.degraded && row.degraded_reason === "rate_limited",
  ).length;

  const operations: Record<QueueOperation, number> = {
    create: 0,
    update: 0,
    delete: 0,
  };
  for (const entry of activeQueue) {
    operations[entry.operation] += 1;
  }
  const oldestCreatedAt = activeQueue.reduce<string | null>(
    (oldest, entry) => (!oldest || entry.created_at < oldest ? entry.created_at : oldest),
    null,
  );

  return {
    remaining: attentionIds.size + cloudIds.size + metadataIds.size + aiIds.size,
    stages: {
      cloud: cloudIds.size,
      metadata: metadataIds.size,
      ai: aiIds.size,
      attention: attentionIds.size,
    },
    details: {
      sync: {
        pending: activeQueue.filter((entry) => entry.sync_status === "pending").length,
        syncing: activeQueue.filter((entry) => entry.sync_status === "syncing").length,
        failed: activeQueue.filter((entry) => entry.sync_status === "failed")
          .length,
        operations,
        maxRetries: activeQueue.reduce(
          (highest, entry) => Math.max(highest, entry.retry_count),
          0,
        ),
        oldestCreatedAt,
      },
      metadata: {
        pending: activeBookmarks.filter((bookmark) => bookmark.metadata_status === "pending")
          .length,
        failed: activeBookmarks.filter((bookmark) => bookmark.metadata_status === "failed")
          .length,
        skipped: activeBookmarks.filter((bookmark) => bookmark.metadata_status === "skipped")
          .length,
      },
      ai: {
        trigger: input.pendingAiTriggerIds.size,
        dispatch: input.aiDispatchIds.size,
        retry: input.aiRetryIds.size,
        inFlight: input.aiInFlightIds.size,
        serverPending: input.serverAiQueue.filter((row) => row.status === "pending").length,
        serverProcessing: input.serverAiQueue.filter((row) => row.status === "processing")
          .length,
        serverFailed: input.serverAiQueue.filter((row) => row.status === "failed").length,
        degradedRateLimited,
      },
    },
    diagnostics: {
      sync: input.syncDiagnostics ?? { todo: 0, done: 0, syncedOnce: 0, syncingTwice: 0 },
      metadata: {
        todo: metadataCandidateIds.size,
        done: activeBookmarks.filter(
          (bookmark) =>
            bookmark.metadata_status === "complete" || bookmark.metadata_status === "skipped",
        ).length,
      },
      ai: {
        todo: aiQueuedOnlyIds.size,
        done: input.enrichments.length,
        serverQueued: serverBacklogIds.size,
        activeUnblocked: union(aiQueuedOnlyIds, input.aiInFlightIds).size,
        activeBlocked: union(serverBacklogIds, input.aiInFlightIds).size,
        degradedRateLimited,
      },
    },
  };
}
