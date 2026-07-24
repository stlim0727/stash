// Pure helpers for the AI-enrichment overflow-queue worker (STASH #578 Phase 2
// — see the `pending_ai_enrichment_queue` migration for the schema/cron side).
// Kept dependency-free (no Deno, no fetch, no environment reads) so they're
// unit-testable under the Node test lane; index.ts owns all the actual I/O:
// claiming rows, fetching bookmark/collection/tag context, calling the
// provider, and writing results back.

/** Split `items` into consecutive groups of at most `size` (the last group
 *  may be smaller). Used to chunk a claimed batch into 5-10-item groups, one
 *  Gemini call per group, per the batching design in #578. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new Error('chunk size must be >= 1');
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/** How many total attempts a pending_ai_enrichment row gets before the worker
 *  gives up on it for good. Once a row's attempts reach this cap its status
 *  becomes 'failed', which the claim query never selects again — this bounds
 *  retries on a poison-pill bookmark (content that permanently confuses or
 *  breaks the batch call) instead of retrying it forever every tick. */
export const MAX_ENRICHMENT_ATTEMPTS = 5;

/** Decide the next status/attempts for a pending_ai_enrichment row after a
 *  retryable failure (a whole chunk's batch call errored, or an individual
 *  row couldn't be resolved/saved — see index.ts). Pure so the retry-cap
 *  behavior is unit-testable without a live queue or network. */
export function nextAttemptState(attempts: number): {
  status: 'pending' | 'failed';
  attempts: number;
} {
  const nextAttempts = attempts + 1;
  return {
    attempts: nextAttempts,
    status: nextAttempts >= MAX_ENRICHMENT_ATTEMPTS ? 'failed' : 'pending',
  };
}
