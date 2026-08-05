import type {
  AIEnrichment,
  Bookmark,
  LocalPendingBookmark,
  QueueOperation,
} from "./types";

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

  const syncFailedIds = new Set(
    activeQueue
      .filter(
        (entry) =>
          entry.sync_status === "failed" && !permanentIds.has(entry.local_id),
      )
      .map((entry) => entry.local_id),
  );
  const cloudCandidateIds = new Set(
    activeQueue
      .filter(
        (entry) =>
          (entry.sync_status === "pending" || entry.sync_status === "syncing") &&
          !permanentIds.has(entry.local_id) &&
          !syncFailedIds.has(entry.local_id),
      )
      .map((entry) => entry.local_id),
  );

  const enrichmentIds = new Set(input.enrichments.map((row) => row.bookmark_id));
  const unresolvedServerFailedIds = new Set(
    input.serverAiQueue
      .filter((row) => row.status === "failed" && !enrichmentIds.has(row.bookmark_id))
      .map((row) => row.bookmark_id),
  );
  const attentionIds = union(syncFailedIds, unresolvedServerFailedIds);
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
        degradedRateLimited: input.enrichments.filter(
          (row) => row.degraded && row.degraded_reason === "rate_limited",
        ).length,
      },
    },
  };
}
