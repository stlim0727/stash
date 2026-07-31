// Pure helpers for the AI-enrichment overflow-queue worker (STASH #578 Phase 2
// — see the `pending_ai_enrichment_queue` migration for the schema/cron side).
// Kept dependency-free (no Deno, no fetch, no environment reads) so they're
// unit-testable under the Node test lane; index.ts owns all the actual I/O:
// claiming rows, fetching bookmark/collection/tag context, calling the
// provider, and writing results back.

/** Split `items` into consecutive groups of at most `size` (the last group
 *  may be smaller). Used to walk a claimed batch in bounded-concurrency waves
 *  — index.ts awaits one wave before starting the next, so at most `size`
 *  provider calls are ever in flight. (It once cut the batch into groups that
 *  each became ONE multi-bookmark model call; that positional mapping is what
 *  crossed suggestions between links — see processEnrichmentRow.) */
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

// ── Drained-queue push notification (STASH #579) ────────────────────────────
// Pure planning/formatting helpers for "notify a user once their ENTIRE
// pending_ai_enrichment backlog drains to zero" — index.ts's notifyDrainedUsers
// owns the actual I/O (the remaining-rows query, the push_tokens lookup, and
// the Expo API call); everything below is dependency-free so it's unit-testable
// without a live queue, a network, or Deno.

/** Per-user tally built from one tick's just-processed rows: how many rows
 *  this tick attributed to them, and the most recently seen `locale` among
 *  those rows (for choosing the push copy's language). Counts every row
 *  regardless of success/failure — same "these ran" semantics as the in-app
 *  burst toast's `recordAiEnrichmentDispatchSettled` (ai-enrichment-burst.ts),
 *  not a health report. */
export interface UserBatchTally {
  count: number;
  locale: string | null;
}

/** Group one tick's eligible (processed) rows by user_id. This is the count
 *  used in the push copy ("N bookmarks summarized & tagged") — it reflects
 *  only THIS tick's contribution, not a running total across every tick a
 *  multi-tick backlog took to drain. In the common case (an overflow burst
 *  fits within one worker tick's BATCH_CLAIM_LIMIT) this is the same number;
 *  a backlog large enough to span several ticks would under-report. Tracking
 *  a true running total would need new per-user state; deliberately deferred
 *  for v1 (see the #579 PR notes). */
export function tallyProcessedByUser(
  rows: readonly { user_id: string; locale: string | null }[],
): Map<string, UserBatchTally> {
  const tally = new Map<string, UserBatchTally>();
  for (const row of rows) {
    const existing = tally.get(row.user_id);
    if (existing) {
      existing.count += 1;
      if (row.locale) {
        existing.locale = row.locale;
      }
    } else {
      tally.set(row.user_id, { count: 1, locale: row.locale });
    }
  }
  return tally;
}

/** Which of `affectedUserIds` have zero remaining pending/processing rows —
 *  i.e. whose backlog just drained to zero and should be notified. A plain
 *  set difference; the caller is responsible for sourcing
 *  `stillPendingUserIds` from ONE grouped query across all affected users
 *  (not a per-user query, not a full-table scan — see index.ts). */
export function pickDrainedUsers(
  affectedUserIds: readonly string[],
  stillPendingUserIds: ReadonlySet<string>,
): string[] {
  return affectedUserIds.filter((id) => !stillPendingUserIds.has(id));
}

/** Push notification body copy, in the two locales #573 already ships
 *  (en/ko). Mirrors the wording style of the in-app burst toast's
 *  `toast.aiEnrichmentBurst` string ("{count} bookmarks summarized & tagged",
 *  apps/mobile/src/i18n/messages.ts) but is NOT the same string constant —
 *  edge functions run under Deno, isolated from the mobile app's bundler and
 *  i18n catalog, so this is a small, deliberately narrow duplicate of just
 *  this one message. Keep it in sync by hand if the mobile wording changes;
 *  add a locale here only once the mobile catalog also supports it. Unlike
 *  the toast (which only ever fires at count >= 2, see
 *  AI_ENRICHMENT_BURST_TOAST_MIN), a drained overflow-queue push can
 *  legitimately fire at count === 1, so this pluralizes properly instead of
 *  always using the toast's fixed plural form. */
export const PUSH_BODY_BY_LOCALE: Record<string, (count: number) => string> = {
  en: (count) => `${count} bookmark${count === 1 ? '' : 's'} summarized & tagged`,
  ko: (count) => `북마크 ${count}개가 요약 및 태그 정리되었어요`,
};

/** Resolve push body copy for a locale, falling back to English for an
 *  unset/unsupported locale (mirrors the mobile i18n catalog's own
 *  missing-key-falls-back-to-English rule). */
export function pushBodyForLocale(locale: string | null | undefined, count: number): string {
  const key = locale && PUSH_BODY_BY_LOCALE[locale] ? locale : 'en';
  return PUSH_BODY_BY_LOCALE[key](count);
}

/** The push title, brand-only (never translated) — matches `app.name` in
 *  both mobile i18n catalogs. */
export const PUSH_TITLE = 'Keepory';

/** The shape of one ticket in Expo push API's synchronous send response
 *  (`{ data: ExpoPushTicket[] }`) that we actually read. */
export interface ExpoPushTicket {
  status: string;
  message?: string;
  details?: { error?: string };
}

/** Which tokens (by index, matching the request array's order) Expo's
 *  synchronous ticket response already flagged as unregistered and should be
 *  deleted from push_tokens. Deliberately uses ONLY the immediate send
 *  response's per-ticket status, not Expo's separate async receipt-polling
 *  endpoint — see index.ts's notifyUserDrained for why that's out of scope
 *  for v1 (a token whose invalidity only shows up later via a receipt just
 *  gets caught on a future send instead). */
export function staleTokenIndexes(tickets: readonly ExpoPushTicket[]): number[] {
  const indexes: number[] = [];
  tickets.forEach((ticket, i) => {
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      indexes.push(i);
    }
  });
  return indexes;
}
