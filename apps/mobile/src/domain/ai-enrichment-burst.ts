/**
 * Pure planning for staggering the automatic AI-enrichment trigger across a
 * burst of bookmarks (STASH #574 Phase 1) — e.g. a multi-share or several
 * rapid manual saves whose metadata all settle around the same time. Without
 * this, the store's auto-trigger effect would fire one `ai-enrich` request per
 * bookmark, all in the same tick.
 *
 * This module only tracks queue membership and a settled-dispatch count so
 * both are unit-testable without React, timers, or the network — the store
 * owns the actual `setInterval`-driven drain loop and the real
 * `requestAiEnrichment` calls (see `store/bookmarks.tsx`). NOT the sync
 * pending-mutation queue (`sync/`) — that queues CRUD writes for upload; this
 * queues LLM-call *scheduling* for a completely different concern.
 */

export interface AiEnrichmentBurstQueue {
  /** Bookmark ids waiting to be dispatched, oldest first. */
  pending: readonly string[];
  /** Dispatches that have settled (succeeded or failed) since the queue last
   *  fully drained. Reset by {@link clearBurstCompletion} once consumed. */
  completedInBurst: number;
}

export const EMPTY_AI_ENRICHMENT_BURST_QUEUE: AiEnrichmentBurstQueue = {
  pending: [],
  completedInBurst: 0,
};

/** Minimum spacing between dispatches, so a burst of captures fires at most
 *  one `ai-enrich` request every this-many milliseconds instead of all at
 *  once. Short enough that a small burst still finishes in a few seconds. */
export const AI_ENRICHMENT_DISPATCH_STAGGER_MS = 400;

/** Only surface the "N bookmarks summarized & tagged" toast for an actual
 *  burst — a single routine background enrichment completing quietly is
 *  normal, unremarkable behavior a toast would just be noise for. */
export const AI_ENRICHMENT_BURST_TOAST_MIN = 2;

/** Queue `id` for staggered dispatch. Idempotent: returns the SAME queue
 *  reference when `id` is already pending (matches this codebase's
 *  same-ref-means-skip convention, e.g. `pending-tags`/`string-set-map`), so a
 *  caller can safely re-enqueue on every render without re-allocating. */
export function enqueueAiEnrichmentDispatch(
  queue: AiEnrichmentBurstQueue,
  id: string,
): AiEnrichmentBurstQueue {
  if (queue.pending.includes(id)) {
    return queue;
  }
  return { ...queue, pending: [...queue.pending, id] };
}

/** Pop the next id to dispatch (oldest first). Returns `null` alongside the
 *  unchanged queue when nothing is pending. */
export function dequeueAiEnrichmentDispatch(
  queue: AiEnrichmentBurstQueue,
): { queue: AiEnrichmentBurstQueue; id: string | null } {
  if (queue.pending.length === 0) {
    return { queue, id: null };
  }
  const [id, ...rest] = queue.pending;
  return { queue: { ...queue, pending: rest }, id };
}

/** Record that one dispatched id's request has settled — counts every
 *  attempt (not just successes): the toast reports "these ran", not a health
 *  report. */
export function recordAiEnrichmentDispatchSettled(
  queue: AiEnrichmentBurstQueue,
): AiEnrichmentBurstQueue {
  return { ...queue, completedInBurst: queue.completedInBurst + 1 };
}

/** True once the queue has fully drained AND at least one dispatch settled —
 *  the point at which the store should decide whether to surface the
 *  completion toast. */
export function isBurstComplete(queue: AiEnrichmentBurstQueue): boolean {
  return queue.pending.length === 0 && queue.completedInBurst > 0;
}

/** Reset the settled counter once its value has been consumed (shown in a
 *  toast, or discarded as below {@link AI_ENRICHMENT_BURST_TOAST_MIN}).
 *  Returns the SAME reference when there's nothing to clear. */
export function clearBurstCompletion(queue: AiEnrichmentBurstQueue): AiEnrichmentBurstQueue {
  return queue.completedInBurst === 0 ? queue : { ...queue, completedInBurst: 0 };
}
