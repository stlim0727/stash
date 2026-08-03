// Supabase Edge Function: ai-enrich
//
// The backend producer of AI enrichments. The mobile client never generates
// suggestions itself — it POSTs a bookmark id here, this function runs the
// configured EnrichmentProvider, writes an `ai_enrichments` row, and returns
// it. The client picks the result up immediately from the response and again
// on its next pull sync.
//
// Auth has two paths (see request-auth.ts):
//   * App requests forward the user's Supabase JWT; it goes straight to
//     PostgREST so Row Level Security scopes every read/write to the bookmark's
//     owner and this function holds no elevated privilege.
//   * The database trigger (dispatch_ai_enrichment) fires server-side once a
//     bookmark's metadata settles, with no user session to forward. It proves
//     itself with the shared `x-ai-enrich-secret` header; we then use the
//     service-role key and scope the work to the bookmark's owner by user_id.
// Deployed with verify_jwt = false (see supabase/config.toml) so the gateway
// neither pre-rejects the app's anonymous-session tokens nor blocks the
// secret-authenticated trigger; authorization is enforced here.
//
// To ship a real model: implement EnrichmentProvider in a new module and
// change the single `provider` assignment below. Nothing else in the function,
// the database, or the app needs to change.

import { DummyProvider } from './dummy-provider.ts';
import { GeminiContentError, GeminiProvider } from './gemini-provider.ts';
import type { EnrichmentInput, EnrichmentOutput, EnrichmentProvider } from './provider.ts';
import { matchSuggestedCollection } from './collection-match.ts';
import { resolveCallerAuth, shouldFailClosedOnRateLimit } from './request-auth.ts';
import { isUuid } from './validation.ts';
import {
  chunk,
  nextAttemptState,
  pickDrainedUsers,
  pushBodyForLocale,
  PUSH_TITLE,
  staleTokenIndexes,
  tallyProcessedByUser,
  type ExpoPushTicket,
} from './batch-worker.ts';

// ── The swappable seam ──────────────────────────────────────────────────────
// Use the Gemini-backed provider when an API key is configured; otherwise fall
// back to the deterministic, network-free heuristics so the pipeline still
// works with no external dependency. `fallbackProvider` also catches live-call
// failures (rate limits, outages) at request time below.
const fallbackProvider = new DummyProvider();

function selectProvider(): EnrichmentProvider {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (apiKey) {
    const timeoutMs = Number(Deno.env.get('GEMINI_TIMEOUT_MS'));
    return new GeminiProvider({
      apiKey,
      model: Deno.env.get('GEMINI_MODEL') ?? undefined,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    });
  }
  return fallbackProvider;
}

const provider: EnrichmentProvider = selectProvider();

// Only throttle when a real, billable model is configured. With no API key the
// pipeline runs the network-free DummyProvider, which costs nothing and has no
// upstream quota to protect — rate-limiting it would just hobble local-only
// deployments and the verify script for no benefit.
const enforceRateLimit = provider !== fallbackProvider;
// ────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Auto-injected by Supabase into every edge function; used only on the trusted
// server-trigger path (never with a client-forwarded token).
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// The shared secret the dispatch_ai_enrichment trigger sends. Set out-of-band
// (`supabase secrets set AI_ENRICH_TRIGGER_SECRET=…`); unset ⇒ no server path.
const TRIGGER_SECRET = Deno.env.get('AI_ENRICH_TRIGGER_SECRET') ?? '';

// How many of the user's existing tags to show the provider so it can reuse
// one instead of minting a near-duplicate. Capped because this list rides in
// every per-capture prompt: a heavy user's full vocabulary (hundreds of tags)
// would bloat token cost for marginal benefit, and the most-used tags (which
// lead the list) are the ones worth reusing anyway.
const MAX_EXISTING_TAGS = 80;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** Verdict shape returned by the `request_ai_enrichment_slot` DB function. */
interface RateLimitVerdict {
  allowed: boolean;
  reason?: string;
  retry_after?: number;
}

/** Why an enrichment fell back to the deterministic heuristics. `not_configured`
 *  means no model API key is set; the rest classify a live-call failure so the
 *  app can tell a transient outage/limit apart from a permanent config gap. */
type DegradedReason = 'not_configured' | 'rate_limited' | 'timeout' | 'provider_error';

/** Map a thrown provider error to a coarse, app-facing degraded reason. The
 *  Gemini provider throws `Gemini request failed (429): …` on rate limits and
 *  `Gemini request timed out after …ms` on timeouts (see gemini-provider.ts). */
function classifyDegradedReason(err: unknown): DegradedReason {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b429\b|RESOURCE_EXHAUSTED|rate limit|quota|limit:\s*0/i.test(message)) {
    return 'rate_limited';
  }
  if (/timed out|timeout|abort/i.test(message)) {
    return 'timeout';
  }
  return 'provider_error';
}

interface BookmarkRow {
  id: string;
  user_id: string;
  url: string | null;
  title: string | null;
  description: string | null;
  notes: string | null;
  site_name: string | null;
  content_type: string;
}

/**
 * Look up whether a user is an anonymous Supabase account, via the GoTrue admin
 * API (service-role). Used ONLY on the server-trigger path when the rate-limit
 * verdict is unavailable, to decide fail-closed (anonymous owner) vs fail-open
 * (real owner) — see shouldFailClosedOnRateLimit.
 *
 * No migration / schema change: GET /auth/v1/admin/users/{id} is a stable
 * service-role endpoint that returns the user record incl. `is_anonymous`.
 *
 * Returns:
 *   - true  → the owner is anonymous (or the record is missing → strict default)
 *   - false → the owner is a confirmed real (non-anonymous) user
 *   - undefined → the lookup failed/threw and anonymity is unknown; the caller
 *     treats undefined as "fail closed" (the safe default).
 */
async function fetchOwnerIsAnonymous(userId: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
    if (res.status === 404) {
      // No such user → treat as anonymous (strict), matching the DB default
      // in request_ai_enrichment_slot_for (coalesce(is_anonymous, true)).
      return true;
    }
    if (!res.ok) {
      console.error('Owner anonymity lookup failed:', res.status);
      return undefined;
    }
    const user = (await res.json()) as { is_anonymous?: unknown };
    // Only an explicit `is_anonymous: false` counts as a real user; missing or
    // non-boolean defaults to anonymous (strict).
    return user.is_anonymous !== false;
  } catch (err) {
    console.error('Owner anonymity lookup threw:', err);
    return undefined;
  }
}

// ── Overflow-queue batch worker (STASH #578 Phase 2) ────────────────────────
// Triggered only by the pg_cron dispatch in the pending_ai_enrichment_queue
// migration (see runBatchWorker's call site above). Everything below is
// service-role-authenticated by construction (serviceRest always sends the
// service-role key) and never shares code paths with the single-item
// synchronous handler above — that path is untouched by this addition.

/** How many pending rows one worker tick claims across ALL users — and, since
 *  every row is now its own provider call (see processEnrichmentRow), also the
 *  worker's ceiling on provider REQUESTS PER TICK. The cron ticks every minute,
 *  so this is effectively a requests-per-minute budget and must stay under the
 *  provider's project-wide RPM limit: Gemini's free tier allows 15 req/min for
 *  the whole project (docs/development/cost-estimates.md), shared with the
 *  synchronous capture path — so this leaves roughly half of it to live
 *  captures, which are user-facing and must not be starved by a background
 *  drain. Raise it only alongside a higher provider limit (e.g. billing
 *  enabled), not to drain a backlog faster: the per-user quota gate below,
 *  not this, is what bounds how fast any one user's overflow clears. */
const BATCH_CLAIM_LIMIT = 8;
/** How many of a tick's rows are in flight at once. Only shapes burstiness
 *  within the tick (BATCH_CLAIM_LIMIT is what caps the tick's total requests);
 *  kept below it so the calls spread across the tick instead of arriving as
 *  one instantaneous spike. */
const ENRICHMENT_CONCURRENCY = 4;

/** Expo's push-send endpoint (STASH #579). Registered/non-anonymous users
 *  only — see the push_tokens migration; nothing here bypasses that, it just
 *  reads whatever rows exist, and the client-side + RLS gates ensure only
 *  real accounts ever have one. */
const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';

function serviceRest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

interface PendingEnrichmentRow {
  id: string;
  bookmark_id: string;
  user_id: string;
  locale: string | null;
  attempts: number;
}

/** Mark a claimed row's outcome. Best-effort: a failure here just means the
 *  row stays 'processing' until the claim query's 10-minute staleness reclaim
 *  picks it up again — never thrown, so one bookkeeping write failure can't
 *  cascade into failing siblings in the same chunk. */
async function markPendingEnrichmentSettled(
  id: string,
  status: 'done' | 'pending' | 'failed',
  attempts: number,
): Promise<void> {
  try {
    const res = await serviceRest(`/pending_ai_enrichment?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, attempts, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error('Batch worker: failed to update pending_ai_enrichment row', id, res.status);
    }
  } catch (err) {
    console.error('Batch worker: error updating pending_ai_enrichment row', id, err);
  }
}

/** Same collections/tags lookup as the single-item path above (see its inline
 *  comments for the full "why"), reimplemented standalone rather than
 *  refactored out of the single-item handler — that handler must stay
 *  provably unchanged by this addition. Scoped to one user at a time; the
 *  worker calls this once per DISTINCT user among a claimed batch, not once
 *  per row, since several claimed rows commonly share a user. */
async function loadEnrichmentContextForUser(
  userId: string,
): Promise<{ collections: Array<{ id: string; name: string }>; existingTags: string[] }> {
  let collections: Array<{ id: string; name: string }> = [];
  const colRes = await serviceRest(`/collections?user_id=eq.${userId}&select=id,name`);
  if (colRes.ok) {
    collections = (await colRes.json()) as Array<{ id: string; name: string }>;
  }
  let existingTags: string[] = [];
  const [activeRes, tagRes] = await Promise.all([
    serviceRest(`/bookmarks?user_id=eq.${userId}&deleted_at=is.null&is_archived=is.false&select=id`),
    serviceRest(`/tags?user_id=eq.${userId}&select=name,bookmark_tags(bookmark_id)`),
  ]);
  if (activeRes.ok && tagRes.ok) {
    const activeIds = new Set(
      ((await activeRes.json()) as Array<{ id: string }>).map((b) => b.id),
    );
    const rows = (await tagRes.json()) as Array<{
      name: unknown;
      bookmark_tags?: Array<{ bookmark_id?: string }>;
    }>;
    existingTags = rows
      .map((row) => ({
        name: typeof row.name === 'string' ? row.name.trim() : '',
        uses: (row.bookmark_tags ?? []).filter(
          (link) => link.bookmark_id && activeIds.has(link.bookmark_id),
        ).length,
      }))
      .filter((tag) => tag.name && tag.uses > 0)
      .sort((a, b) => b.uses - a.uses)
      .slice(0, MAX_EXISTING_TAGS)
      .map((tag) => tag.name);
  }
  return { collections, existingTags };
}

/** Spend one rate-limit slot for `userId` via the existing service-role-only
 *  RPC (request_ai_enrichment_slot_for — see the ai_enrich_server_trigger
 *  migration). This is the fix for the abuse gap a client-writable overflow
 *  queue would otherwise open: without this, a caller could bypass the
 *  synchronous path's 429 entirely by inserting straight into
 *  pending_ai_enrichment (the client-facing INSERT policy has no quota check
 *  of its own — see the migration), then let the worker burn unlimited real
 *  Gemini calls on their behalf. Checked once per CLAIMED ROW (matching the
 *  synchronous path's one-slot-per-bookmark accounting), so N items from the
 *  same user in one tick still only ever consume N of that user's slots.
 *  Only called when `enforceRateLimit` (a real, billable provider is
 *  configured) — see its call site.
 *
 *  Returns two distinct flags because an RPC error fails OPEN (a transient
 *  limiter hiccup must not strand overflow rows forever — this is a best-
 *  effort background job, not a live user-facing request the way the
 *  synchronous path's fail-open/closed policy is for), and that path spends
 *  no real slot:
 *  - `eligible`: whether this row may proceed to a provider call this tick.
 *  - `slotClaimed`: whether the RPC's INSERT actually ran — false on the
 *    fail-open path. Kept distinct so a later rate_limited refund never
 *    deletes an unrelated slot a genuinely earlier, successful call spent
 *    (Codex review, PR #669): eligible-but-not-claimed must never be refunded. */
async function claimEnrichmentQuotaSlot(
  userId: string,
): Promise<{ eligible: boolean; slotClaimed: boolean }> {
  try {
    const res = await serviceRest(`/rpc/request_ai_enrichment_slot_for`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) {
      console.error('Batch worker: rate-limit check failed', userId, res.status);
      return { eligible: true, slotClaimed: false };
    }
    const verdict = (await res.json()) as { allowed?: boolean };
    const allowed = verdict.allowed !== false;
    return { eligible: allowed, slotClaimed: allowed };
  } catch (err) {
    console.error('Batch worker: rate-limit check threw', userId, err);
    return { eligible: true, slotClaimed: false };
  }
}

/** Give back the per-user slot spent by claimEnrichmentQuotaSlot/
 *  request_ai_enrichment_slot(_for) when the attempt it paid for turned out
 *  to be rate_limited by the PROVIDER, not by the user's own quota. Without
 *  this, a provider-side outage permanently burns the user's fixed
 *  daily/hourly budget on retries that produced zero usable output — the
 *  batch worker's overflow queue exists specifically to retry rate_limited
 *  rows, so every retry cycle during a long outage was spending another slot
 *  for nothing, capable of exhausting the full daily cap before the provider
 *  ever recovers. Only called for degradedReason === 'rate_limited' — a real
 *  provider_error or timeout still represents a genuine, concluded attempt
 *  and keeps its charge. Best-effort and never throws: a failed refund just
 *  means this one slot stays spent, same as before this existed. */
async function refundEnrichmentQuotaSlot(userId: string): Promise<void> {
  try {
    const res = await serviceRest(`/rpc/refund_ai_enrichment_slot_for`, {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) {
      console.error('Failed to refund enrichment quota slot', userId, res.status);
    }
  } catch (err) {
    console.error('Error refunding enrichment quota slot', userId, err);
  }
}

/**
 * Append one row to the `ai_enrichment_calls` spend ledger — one row per
 * attempted billable provider call, on BOTH the synchronous and worker paths.
 *
 * Separate from the `ai_enrichments` row because that one is upserted
 * on_conflict=bookmark_id (one row per bookmark, overwritten on every re-run),
 * so its token columns alone would lose a prior call's spend on a manual
 * "Refresh AI suggestions". This append-only table is what
 * `admin_ai_enrichment_activity_24h` sums for cumulative cost/degradation
 * reporting (see the ai_enrichment_calls migration).
 *
 * Skipped when the billable provider was never attempted (not configured) —
 * there's no spend to record. Always written with the service-role key, never
 * a caller-forwarded token: the table carries no client insert policy (see the
 * ai_enrichment_calls_server_only migration) specifically so a client can't
 * POST fabricated token counts and corrupt the ledger. Only this function —
 * which computed `usage` from the provider's real response — may write to it.
 *
 * Best-effort: never throws (a ledger failure must not fail the enrichment
 * itself), but always logs, so a broken ledger doesn't go unnoticed.
 */
async function recordEnrichmentCall(entry: {
  bookmarkId: string;
  userId: string;
  usage: EnrichmentOutput['usage'];
  degraded: boolean;
  degradedReason: DegradedReason | null;
}): Promise<void> {
  if (provider === fallbackProvider || !SERVICE_ROLE_KEY) {
    return;
  }
  try {
    const res = await serviceRest('/ai_enrichment_calls', {
      method: 'POST',
      body: JSON.stringify({
        bookmark_id: entry.bookmarkId,
        user_id: entry.userId,
        model: provider.model,
        prompt_tokens: entry.usage?.prompt_tokens ?? null,
        output_tokens: entry.usage?.output_tokens ?? null,
        total_tokens: entry.usage?.total_tokens ?? null,
        degraded: entry.degraded,
        degraded_reason: entry.degradedReason,
      }),
    });
    if (!res.ok) {
      console.error('Failed to record ai_enrichment_calls row:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Failed to record ai_enrichment_calls row:', err);
  }
}

const EMPTY_ENRICHMENT_CONTEXT = {
  collections: [] as Array<{ id: string; name: string }>,
  existingTags: [] as string[],
};

/** Enrich ONE claimed row with its own provider call and persist the result.
 *
 *  One bookmark per model call, deliberately. This worker used to embed a
 *  whole chunk of bookmarks in a single Gemini call and map the returned JSON
 *  array back to rows BY ARRAY POSITION, with nothing tying an answer to the
 *  bookmark it was about: the response only had to be an array of the right
 *  length. Any reordering, omission-plus-padding, or cross-item bleed in the
 *  model's answer therefore filed one link's summary/tags/collection under a
 *  different link, silently and undetectably — the bug users hit on a bulk
 *  import, which is the one flow that overflows quota into this queue in the
 *  first place. Per-bookmark calls make that class of mix-up structurally
 *  impossible rather than merely discouraged by prompt wording.
 *
 *  Degrades to the deterministic heuristics for THIS bookmark alone when its
 *  call fails (mirroring the single-item synchronous path), so one bad link
 *  can't drag its neighbours down with it. */
async function processEnrichmentRow(
  row: PendingEnrichmentRow,
  bookmarksById: Map<string, BookmarkRow>,
  contextByUser: Map<string, { collections: Array<{ id: string; name: string }>; existingTags: string[] }>,
  slotClaimed: boolean,
): Promise<void> {
  const bookmark = bookmarksById.get(row.bookmark_id);
  if (!bookmark) {
    // Defensive: shouldn't happen (a deleted bookmark cascade-deletes its
    // pending row). Retry rather than fail outright — may be a transient blip.
    const next = nextAttemptState(row.attempts);
    await markPendingEnrichmentSettled(row.id, next.status, next.attempts);
    return;
  }
  const ctx = contextByUser.get(row.user_id) ?? EMPTY_ENRICHMENT_CONTEXT;
  const input: EnrichmentInput = {
    url: bookmark.url,
    title: bookmark.title,
    description: bookmark.description,
    notes: bookmark.notes,
    site_name: bookmark.site_name,
    content_type: bookmark.content_type,
    collections: ctx.collections.map((col) => col.name),
    existing_tags: ctx.existingTags,
    locale: row.locale ?? undefined,
  };

  // Null only when the provider rate-limited us, which is handled below by
  // putting the row back on the queue rather than persisting anything.
  let output: EnrichmentOutput | null = null;
  let usedModel = provider.model;
  let degraded = provider === fallbackProvider;
  let degradedReason: DegradedReason | null = degraded ? 'not_configured' : null;
  let usage: EnrichmentOutput['usage'] = null;
  try {
    output = await provider.enrich(input);
    usage = output.usage ?? null;
  } catch (err) {
    if (provider === fallbackProvider) {
      // The network-free heuristics threw — nothing left to fall back to.
      console.error('Batch worker: fallback provider failed', row.bookmark_id, err);
      const next = nextAttemptState(row.attempts);
      await markPendingEnrichmentSettled(row.id, next.status, next.attempts);
      return;
    }
    console.error('Batch worker: provider failed', row.bookmark_id, err);
    degraded = true;
    degradedReason = classifyDegradedReason(err);
    // A GeminiContentError reached Gemini and may have spent tokens even
    // though its response had no usable candidate — keep that spend rather
    // than losing it to the fallback's null usage (same as the single-item path).
    usage = err instanceof GeminiContentError ? err.usage ?? null : null;
    if (degradedReason !== 'rate_limited') {
      output = await fallbackProvider.enrich(input);
      usedModel = fallbackProvider.model;
    }
  }

  // One ledger row per attempted provider call, degraded ones included — the
  // rate_limited/timeout/provider_error counts in admin_ai_enrichment_activity_24h
  // are precisely how an outage or an exhausted project quota becomes visible.
  await recordEnrichmentCall({
    bookmarkId: row.bookmark_id,
    userId: row.user_id,
    usage,
    degraded,
    degradedReason,
  });

  if (!output) {
    // Rate-limited by the PROVIDER's project-wide limit (Gemini's 15 req/min
    // or 1,000/day free tier), not by this user's own quota. Unlike the
    // synchronous path — which has nowhere to put the request and so returns
    // degraded heuristics — a queued row can simply wait: put it back to
    // 'pending' with NO attempts penalty so a later tick retries it against a
    // refreshed limit. Persisting the heuristics here instead would freeze
    // generic, non-AI suggestions onto the bookmark permanently, since the
    // queue row would be settled 'done' and never revisited. Same "not your
    // turn yet, no penalty" treatment the per-user quota deferral gets in
    // runBatchWorker.
    //
    // This row's per-user quota slot was already spent at claim time —
    // refund it now that the attempt is known to have produced nothing (see
    // refundEnrichmentQuotaSlot's docs), so a long provider outage doesn't
    // burn the user's fixed budget on retries that never got a usable answer.
    // Only when a slot was actually claimed: a fail-open eligibility (the
    // quota RPC itself errored) never inserted one, so refunding here would
    // instead delete an unrelated slot a genuinely earlier call spent.
    if (slotClaimed) {
      await refundEnrichmentQuotaSlot(row.user_id);
    }
    await markPendingEnrichmentSettled(row.id, 'pending', row.attempts);
    return;
  }

  const matched = matchSuggestedCollection(ctx.collections, output.suggested_collection);
  const enrichmentRow = {
    bookmark_id: row.bookmark_id,
    user_id: row.user_id,
    summary: output.summary,
    topics: output.topics,
    suggested_tags: output.suggested_tags,
    suggested_collection_id: matched?.id ?? null,
    suggested_collection_name:
      !matched && output.suggested_collection?.trim() ? output.suggested_collection.trim() : null,
    model: usedModel,
    status: 'complete',
    confidence: output.confidence,
    degraded,
    degraded_reason: degradedReason,
    // Now that each row has its own call, its usage is genuinely per-bookmark
    // and can be recorded (a batched call's usage covered a whole chunk, so it
    // was left null rather than divided) — as is the ai_enrichment_calls
    // ledger row written above.
    prompt_tokens: usage?.prompt_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    updated_at: new Date().toISOString(),
  };
  try {
    const saveRes = await serviceRest(`/ai_enrichments?on_conflict=bookmark_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(enrichmentRow),
    });
    if (!saveRes.ok) {
      console.error(
        'Batch worker: failed to save ai_enrichments row',
        row.bookmark_id,
        saveRes.status,
      );
      const next = nextAttemptState(row.attempts);
      await markPendingEnrichmentSettled(row.id, next.status, next.attempts);
      return;
    }
    await markPendingEnrichmentSettled(row.id, 'done', row.attempts);
  } catch (err) {
    console.error('Batch worker: error saving ai_enrichments row', row.bookmark_id, err);
    const next = nextAttemptState(row.attempts);
    await markPendingEnrichmentSettled(row.id, next.status, next.attempts);
  }
}

interface PushTokenRow {
  id: string;
  token: string;
}

/**
 * Send one drained-queue push notification to every device `userId` has
 * registered, then delete any token Expo's synchronous response already
 * flagged as unregistered. Never throws — every failure is caught and logged
 * by the caller (`notifyDrainedUsers`), which wraps every per-user call the
 * same way; this function additionally guards its own body so a bug here
 * can't take down a sibling user's notification in the same `Promise.all`.
 */
async function notifyUserDrained(
  userId: string,
  count: number,
  locale: string | null,
): Promise<void> {
  try {
    // Service-role read — no RLS needed server-side (see the push_tokens
    // migration; the client's own SELECT policy is for its own UI only).
    const tokensRes = await serviceRest(`/push_tokens?user_id=eq.${userId}&select=id,token`);
    if (!tokensRes.ok) {
      console.error('Drained-queue: failed to load push tokens', userId, tokensRes.status);
      return;
    }
    const tokens = (await tokensRes.json()) as PushTokenRow[];
    if (tokens.length === 0) {
      return; // Opted out / never registered a device. Nothing to send.
    }

    const body = pushBodyForLocale(locale, count);
    const messages = tokens.map((row) => ({
      to: row.token,
      sound: 'default',
      title: PUSH_TITLE,
      body,
      data: { type: 'ai_enrichment_drained' },
    }));

    let tickets: ExpoPushTicket[];
    try {
      const sendRes = await fetch(EXPO_PUSH_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      const payload = (await sendRes.json()) as { data?: ExpoPushTicket[] };
      if (!sendRes.ok || !payload.data) {
        console.error('Drained-queue: Expo push send failed', userId, sendRes.status);
        return;
      }
      tickets = payload.data;
    } catch (err) {
      console.error('Drained-queue: Expo push send threw', userId, err);
      return;
    }

    // Stale-token cleanup (immediate ticket status only — see
    // staleTokenIndexes' docs for why the async receipt endpoint is
    // deliberately out of scope for v1). Best-effort: a failed delete just
    // means this token gets tried again (and possibly cleaned up) next time.
    const staleIndexes = staleTokenIndexes(tickets);
    await Promise.all(
      staleIndexes.map((i) => {
        const tokenRow = tokens[i];
        if (!tokenRow) return Promise.resolve();
        return serviceRest(`/push_tokens?id=eq.${tokenRow.id}`, { method: 'DELETE' }).catch(
          (err) => {
            console.error('Drained-queue: failed to delete stale push token', tokenRow.id, err);
          },
        );
      }),
    );
  } catch (err) {
    console.error('Drained-queue: notifyUserDrained failed', userId, err);
  }
}

/**
 * After a tick's chunks finish, notify every user among `eligible` whose
 * ENTIRE pending_ai_enrichment backlog just drained to zero (STASH #579) —
 * not once per tick/chunk. Detection is a single grouped query across every
 * affected user (never a full-table scan, never one query per user — see
 * `pickDrainedUsers`'s docs). Wrapped so NOTHING here can ever fail or delay
 * the worker's actual job: `runBatchWorker` awaits this after processing so
 * the edge function's isolate stays alive for it, but every error inside is
 * caught here and never rethrown.
 */
async function notifyDrainedUsers(eligible: PendingEnrichmentRow[]): Promise<void> {
  if (eligible.length === 0) {
    return;
  }
  try {
    const tally = tallyProcessedByUser(eligible);
    const affectedUserIds = [...tally.keys()];

    const remainingRes = await serviceRest(
      `/pending_ai_enrichment?select=user_id&user_id=in.(${affectedUserIds.join(',')})&status=in.(pending,processing)`,
    );
    if (!remainingRes.ok) {
      console.error('Drained-queue: remaining-rows check failed', remainingRes.status);
      return;
    }
    const stillPendingUserIds = new Set(
      ((await remainingRes.json()) as Array<{ user_id: string }>).map((row) => row.user_id),
    );
    const drainedUserIds = pickDrainedUsers(affectedUserIds, stillPendingUserIds);
    if (drainedUserIds.length === 0) {
      return;
    }

    await Promise.all(
      drainedUserIds.map((userId) => {
        const info = tally.get(userId);
        if (!info) return Promise.resolve();
        return notifyUserDrained(userId, info.count, info.locale);
      }),
    );
  } catch (err) {
    console.error('Drained-queue notification pass failed:', err);
  }
}

async function runBatchWorker(): Promise<Response> {
  try {
    const claimRes = await serviceRest(`/rpc/claim_pending_ai_enrichment_batch`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ p_limit: BATCH_CLAIM_LIMIT }),
    });
    if (!claimRes.ok) {
      console.error('Batch worker: claim RPC failed', claimRes.status, await claimRes.text());
      return json({ error: 'claim_failed' }, 500);
    }
    const claimed = (await claimRes.json()) as PendingEnrichmentRow[];
    if (claimed.length === 0) {
      return json({ processed: 0, deferred: 0 }, 200);
    }

    // Per-row quota gate (see claimEnrichmentQuotaSlot's docs for why this is
    // required, not optional). Skipped entirely when running the network-free
    // fallback provider — nothing to protect (mirrors `enforceRateLimit` on
    // the single-item path above).
    let eligible = claimed;
    let deferred: PendingEnrichmentRow[] = [];
    // Per-row record of whether its quota RPC actually inserted a slot (vs.
    // fail-open eligibility with no real charge) — see claimEnrichmentQuotaSlot
    // and processEnrichmentRow's refund guard.
    const slotClaimedByRowId = new Map<string, boolean>();
    if (enforceRateLimit) {
      const results = await Promise.all(claimed.map((row) => claimEnrichmentQuotaSlot(row.user_id)));
      claimed.forEach((row, i) => slotClaimedByRowId.set(row.id, results[i].slotClaimed));
      eligible = claimed.filter((_, i) => results[i].eligible);
      deferred = claimed.filter((_, i) => !results[i].eligible);
    } else {
      claimed.forEach((row) => slotClaimedByRowId.set(row.id, false));
    }
    // Rows still over quota go straight back to 'pending' with no attempts
    // penalty — this isn't a failure, just "try again once the window rolls
    // over" — so the next tick's claim picks them up again unchanged.
    await Promise.all(deferred.map((row) => markPendingEnrichmentSettled(row.id, 'pending', row.attempts)));

    if (eligible.length === 0) {
      return json({ processed: 0, deferred: deferred.length }, 200);
    }

    const bookmarkIds = [...new Set(eligible.map((row) => row.bookmark_id))];
    const bookmarksRes = await serviceRest(
      `/bookmarks?id=in.(${bookmarkIds.join(',')})&select=id,user_id,url,title,description,notes,site_name,content_type`,
    );
    const bookmarks = bookmarksRes.ok ? ((await bookmarksRes.json()) as BookmarkRow[]) : [];
    const bookmarksById = new Map(bookmarks.map((b) => [b.id, b] as const));

    const userIds = [...new Set(eligible.map((row) => row.user_id))];
    const contexts = await Promise.all(userIds.map((id) => loadEnrichmentContextForUser(id)));
    const contextByUser = new Map(userIds.map((id, i) => [id, contexts[i]] as const));

    // Bounded concurrency: each row is its own provider call now, so waves run
    // one after another (only the rows WITHIN a wave overlap). Firing all
    // BATCH_CLAIM_LIMIT calls at once would burst straight into the model
    // provider's own per-minute limit and degrade a chunk of them to heuristics.
    for (const wave of chunk(eligible, ENRICHMENT_CONCURRENCY)) {
      await Promise.all(
        wave.map((row) =>
          processEnrichmentRow(row, bookmarksById, contextByUser, slotClaimedByRowId.get(row.id) ?? false),
        ),
      );
    }

    // STASH #579: best-effort drained-queue push notification, after the
    // real work above is fully settled. Never throws (see its own docs) and
    // never affects `processed`/`deferred` below.
    await notifyDrainedUsers(eligible);

    return json({ processed: eligible.length, deferred: deferred.length }, 200);
  } catch (error) {
    console.error('Batch worker failed:', error);
    return json({ error: error instanceof Error ? error.message : 'Batch worker failed' }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const caller = resolveCallerAuth({
    authorization: req.headers.get('Authorization'),
    secretHeader: req.headers.get('x-ai-enrich-secret'),
    triggerSecret: TRIGGER_SECRET || null,
  });
  if (caller.kind === 'unauthorized') {
    return json({ error: 'Unauthorized' }, 401);
  }
  const serverPath = caller.kind === 'server';
  if (serverPath && !SERVICE_ROLE_KEY) {
    // The trigger authenticated, but the function isn't configured to act for it.
    console.error('Server-path request but SUPABASE_SERVICE_ROLE_KEY is unset');
    return json({ error: 'Server path not configured' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // STASH #578 Phase 2: the pg_cron-scheduled overflow-queue worker pings this
  // endpoint with `{ batch_worker: true }` instead of a bookmark_id. Gated on
  // `serverPath` (the shared-secret caller, never a normal user JWT) — this
  // mode reads/writes across ALL users via service-role, so it must never be
  // reachable by anyone holding just their own session token.
  if (body.batch_worker === true) {
    if (!serverPath) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (!SERVICE_ROLE_KEY) {
      console.error('Batch worker invoked but SUPABASE_SERVICE_ROLE_KEY is unset');
      return json({ error: 'Server path not configured' }, 500);
    }
    return await runBatchWorker();
  }

  const bookmarkId = body.bookmark_id;
  if (typeof bookmarkId !== 'string' || !bookmarkId) {
    return json({ error: 'bookmark_id is required' }, 400);
  }
  // Reject a non-UUID bookmark_id BEFORE it is interpolated into any
  // id=eq.${bookmarkId} / bookmark_id=eq.${bookmarkId} PostgREST filter below.
  // On the server path the service-role key bypasses RLS, so a forged id like
  // `x&select=*&or=(...)` could otherwise smuggle arbitrary PostgREST params.
  // Guarded here, before any DB call, so the function fails fast.
  if (!isUuid(bookmarkId)) {
    return json({ error: 'bookmark_id must be a UUID' }, 400);
  }

  // The user's locale, so a model-backed provider writes the summary/tags in
  // their language (M12). Optional — the provider falls back to English.
  const locale =
    typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : undefined;

  // The client may send the freshest local metadata it has (title/site/etc.).
  // The cloud row can lag behind on-device OpenGraph enrichment — a bookmark
  // captured seconds ago is often still a bare URL server-side — so without
  // this the model would reason about an empty row and return nothing useful.
  // We overlay these onto the loaded row below; the DB stays the source of
  // truth for identity (id/user_id) and is never written from client input.
  const clientMetadata = (body.metadata ?? null) as Record<string, unknown> | null;
  const overlay = (dbValue: string | null, key: string): string | null => {
    const provided = clientMetadata?.[key];
    return typeof provided === 'string' && provided.trim() ? provided.trim() : dbValue;
  };

  // PostgREST auth: the app path forwards the user's token (RLS enforced); the
  // server path uses the service-role key (RLS bypassed) and must therefore
  // scope every query to the bookmark's owner by hand (user_id filters below).
  // Narrow on caller.kind (not the serverPath boolean) so the type checker sees
  // `authorization` is present on the app branch.
  const restAuth =
    caller.kind === 'server'
      ? { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
      : { apikey: ANON_KEY, Authorization: caller.authorization };
  const rest = (path: string, init: RequestInit = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...init,
      headers: {
        ...restAuth,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  try {
    const bookmarkRes = await rest(
      `/bookmarks?id=eq.${bookmarkId}&select=id,user_id,url,title,description,notes,site_name,content_type&limit=1`,
    );
    if (!bookmarkRes.ok) {
      return json({ error: 'Failed to load bookmark' }, bookmarkRes.status);
    }
    const [bookmark] = (await bookmarkRes.json()) as BookmarkRow[];
    if (!bookmark) {
      return json({ error: 'Bookmark not found' }, 404);
    }

    // On the server path nothing has enriched this bookmark unless a prior
    // dispatch (or the app) already did — in which case skip before spending a
    // rate-limit slot or calling the model. This is the dedupe seam with the
    // client trigger: whichever fires first wins. (The app path always runs, so
    // a manual "refresh AI suggestions" can re-enrich.)
    if (serverPath) {
      const existing = await rest(
        `/ai_enrichments?bookmark_id=eq.${bookmarkId}&select=id&limit=1`,
      );
      if (existing.ok) {
        const [row] = (await existing.json()) as Array<{ id: string }>;
        if (row) {
          return json({ skipped: 'already_enriched' }, 200);
        }
      }
    }

    // Load the user's collections up front: their names guide the provider
    // toward an existing bucket, and the same list resolves the returned name
    // hint to a real id below — never inventing or creating a collection here.
    // Scoped to the owner explicitly so the service-role path can't leak another
    // user's collection names (a no-op on the RLS-scoped app path).
    let collections: Array<{ id: string; name: string }> = [];
    const colRes = await rest(`/collections?user_id=eq.${bookmark.user_id}&select=id,name`);
    if (colRes.ok) {
      collections = (await colRes.json()) as Array<{ id: string; name: string }>;
    }

    // Load the user's existing tags so the provider reuses an established tag
    // instead of coining a near-duplicate — the fix for tag fragmentation, where
    // most users' vocabularies are >80% single-use synonyms of a handful of real
    // concepts. Count only links on ACTIVE bookmarks (deleted_at is null and not
    // archived, matching the Inbox's isActiveBookmark rule) and drop tags with
    // no active links: removing a tag leaves its `tags` row behind, and trashing
    // a bookmark keeps its links, so counting all links would resurface
    // vocabulary the user already cleared and instruct the model to reuse it.
    // Ranked most-used-first (in the function, so it's independent of PostgREST
    // aggregate-ordering support) and capped at MAX_EXISTING_TAGS to bound
    // per-capture prompt cost. Owner-scoped so the service-role path can't leak
    // another user's tags (a no-op on the RLS-scoped app path).
    let existingTags: string[] = [];
    const [activeRes, tagRes] = await Promise.all([
      rest(
        `/bookmarks?user_id=eq.${bookmark.user_id}&deleted_at=is.null&is_archived=is.false&select=id`,
      ),
      rest(`/tags?user_id=eq.${bookmark.user_id}&select=name,bookmark_tags(bookmark_id)`),
    ]);
    if (activeRes.ok && tagRes.ok) {
      const activeIds = new Set(
        ((await activeRes.json()) as Array<{ id: string }>).map((b) => b.id),
      );
      const rows = (await tagRes.json()) as Array<{
        name: unknown;
        bookmark_tags?: Array<{ bookmark_id?: string }>;
      }>;
      existingTags = rows
        .map((row) => ({
          name: typeof row.name === 'string' ? row.name.trim() : '',
          uses: (row.bookmark_tags ?? []).filter(
            (link) => link.bookmark_id && activeIds.has(link.bookmark_id),
          ).length,
        }))
        .filter((tag) => tag.name && tag.uses > 0)
        .sort((a, b) => b.uses - a.uses)
        .slice(0, MAX_EXISTING_TAGS)
        .map((tag) => tag.name);
    }

    // Per-user rate limit (enforced atomically in Postgres). Checked only after
    // the bookmark is confirmed to exist — an invalid request shouldn't spend a
    // slot — and only when a billable provider is configured. The DB function
    // scopes the count to the caller via the forwarded JWT (auth.uid()), so a
    // user can only ever exhaust their own quota.
    // Whether the RPC below actually inserted a slot (vs. the fail-open path
    // reaching the provider with nothing spent) — a later rate_limited refund
    // must only fire when true, or it deletes an unrelated slot a genuinely
    // earlier call spent (Codex review, PR #669).
    let slotClaimed = false;
    if (enforceRateLimit) {
      let verdict: RateLimitVerdict | null = null;
      // Whether we actually obtained a verdict. Distinct from `verdict` so a
      // null verdict that came back as "allowed: null" can't be confused with
      // "couldn't reach the limiter".
      let verdictObtained = false;
      try {
        // The app path's RPC scopes to the caller via the forwarded JWT
        // (auth.uid()); the server path has no token, so the service-role-only
        // variant takes the owner id explicitly.
        const rlRes = serverPath
          ? await rest(`/rpc/request_ai_enrichment_slot_for`, {
              method: 'POST',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ p_user_id: bookmark.user_id }),
            })
          : await rest(`/rpc/request_ai_enrichment_slot`, {
              method: 'POST',
              headers: { Prefer: 'return=representation' },
              body: '{}',
            });
        if (rlRes.ok) {
          verdict = (await rlRes.json()) as RateLimitVerdict;
          verdictObtained = true;
        } else {
          console.error('Rate-limit check failed:', rlRes.status);
        }
      } catch (err) {
        console.error('Rate-limit check threw:', err);
      }

      if (!verdictObtained) {
        // The verdict couldn't be obtained (missing function, transient error).
        // Decide fail-closed vs fail-open by who owns the cost:
        //  - anonymous caller         → CLOSED (limiter is the sole cost control)
        //  - signed-in caller         → OPEN  (real account is a cost anchor)
        //  - server/trigger path      → follows the TARGET BOOKMARK'S OWNER, since
        //    the trigger fires for user rows: anonymous owner → CLOSED (an anon
        //    user must not drive unthrottled server enrichment during an outage),
        //    real owner → OPEN (don't break a real user's background enrichment).
        // On the server path we resolve the owner's anonymity via the GoTrue
        // admin API (service-role, no migration); undetermined ⇒ closed (safe).
        let ownerIsAnonymous: boolean | undefined;
        if (serverPath) {
          ownerIsAnonymous = await fetchOwnerIsAnonymous(bookmark.user_id);
        }
        if (shouldFailClosedOnRateLimit(caller, ownerIsAnonymous)) {
          console.error(
            'Rate-limit verdict unavailable; failing closed',
            serverPath ? `(server path, ownerIsAnonymous=${ownerIsAnonymous})` : '(anonymous caller)',
          );
          return json(
            { error: 'rate_limit_unavailable', reason: 'rate_limit_unavailable', retry_after: 60 },
            503,
            { 'Retry-After': '60' },
          );
        }
        console.error('Rate-limit verdict unavailable; allowing request (real-owner/signed-in path)');
      } else if (verdict && !verdict.allowed) {
        const retryAfter = Math.max(1, Math.floor(verdict.retry_after ?? 60));
        return json(
          { error: 'rate_limited', reason: verdict.reason ?? 'rate_limited', retry_after: retryAfter },
          429,
          { 'Retry-After': String(retryAfter) },
        );
      } else {
        // Reached only when the RPC succeeded and returned allowed — the only
        // branch where the RPC's own INSERT actually ran.
        slotClaimed = true;
      }
    }

    const input = {
      url: bookmark.url,
      title: overlay(bookmark.title, 'title'),
      description: overlay(bookmark.description, 'description'),
      notes: overlay(bookmark.notes, 'notes'),
      site_name: overlay(bookmark.site_name, 'site_name'),
      content_type: overlay(bookmark.content_type, 'content_type') ?? bookmark.content_type,
      collections: collections.map((col) => col.name),
      existing_tags: existingTags,
      locale,
    };

    // Run the configured provider; if a live model call fails (rate limit,
    // outage, bad response), degrade to the deterministic heuristics rather
    // than failing the whole request. `degraded` records that the result came
    // from the fallback — and why — so the app can show a clear, non-error
    // signal instead of silently passing off heuristics as real AI (issue #101,
    // where the free-tier `limit:0` case masked the cause).
    let output: EnrichmentOutput;
    let usedModel = provider.model;
    let degraded = provider === fallbackProvider;
    let degradedReason: DegradedReason | null = degraded ? 'not_configured' : null;
    let usage: EnrichmentOutput['usage'] = null;
    try {
      output = await provider.enrich(input);
      usage = output.usage ?? null;
    } catch (err) {
      if (provider === fallbackProvider) {
        throw err;
      }
      console.error('Primary enrichment provider failed; using fallback:', err);
      output = await fallbackProvider.enrich(input);
      usedModel = fallbackProvider.model;
      degraded = true;
      degradedReason = classifyDegradedReason(err);
      // A GeminiContentError means the call reached Gemini and may have
      // consumed tokens even though the response had no usable candidate
      // (safety block, malformed structured output) — preserve that spend
      // instead of losing it to the fallback's null usage.
      usage = err instanceof GeminiContentError ? err.usage ?? null : null;

      // rate_limited is transient — unlike a real provider outage or a
      // missing config, Gemini's limit will lift on its own. Rather than
      // settling for the heuristic fallback permanently, enqueue into the
      // SAME overflow queue the client uses for its own 429s (see
      // 20260723150000_pending_ai_enrichment_queue.sql) so the pg_cron batch
      // worker retries this bookmark with the real model once capacity frees
      // up. ai_enrichments' on_conflict=bookmark_id upsert means a later
      // success silently overwrites the degraded row below — no client
      // change needed, the next sync pull just sees the upgraded content.
      // Best-effort and never blocks the response: an enqueue failure just
      // means this bookmark keeps today's degraded result, same as before
      // this existed. Same on_conflict/ignore-duplicates shape as the
      // client's own enqueuePendingEnrichment (api/bookmarks.ts) so a bulk
      // import that's already queued this bookmark itself no-ops here too.
      if (degradedReason === 'rate_limited') {
        // The slot spent above (request_ai_enrichment_slot(_for)) paid for an
        // attempt that the provider itself rejected — refund it before
        // queueing the retry, for the same reason processEnrichmentRow's
        // batch-worker retries do (see refundEnrichmentQuotaSlot's docs).
        // Only when a slot was actually claimed (see `slotClaimed`'s docs
        // above) — the fail-open path never spent one.
        if (slotClaimed) {
          await refundEnrichmentQuotaSlot(bookmark.user_id);
        }
        try {
          const enqueueRes = await rest(`/pending_ai_enrichment?on_conflict=bookmark_id`, {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify({
              bookmark_id: bookmark.id,
              user_id: bookmark.user_id,
              ...(locale ? { locale } : {}),
            }),
          });
          if (!enqueueRes.ok) {
            console.error(
              'Sync path: failed to enqueue rate_limited bookmark for retry',
              bookmark.id,
              enqueueRes.status,
            );
          }
        } catch (enqueueErr) {
          console.error(
            'Sync path: error enqueueing rate_limited bookmark for retry',
            bookmark.id,
            enqueueErr,
          );
        }
      }
    }

    // Resolve the collection NAME hint to one of the user's existing
    // collections (tolerant of case/spacing/punctuation); never create one here.
    // When nothing fits we keep the raw proposed name so the app can offer to
    // create that collection — that's the difference between "file into an
    // existing folder" and "make a new one", surfaced as distinct chips client-
    // side. The name is null when the resolution found an existing match (the id
    // covers it) or the provider proposed nothing.
    const matchedCollection = matchSuggestedCollection(collections, output.suggested_collection);
    const suggestedCollectionId = matchedCollection?.id ?? null;
    const suggestedCollectionName =
      !matchedCollection && output.suggested_collection?.trim()
        ? output.suggested_collection.trim()
        : null;

    const now = new Date().toISOString();
    const row = {
      bookmark_id: bookmark.id,
      user_id: bookmark.user_id,
      summary: output.summary,
      topics: output.topics,
      suggested_tags: output.suggested_tags,
      suggested_collection_id: suggestedCollectionId,
      suggested_collection_name: suggestedCollectionName,
      model: usedModel,
      status: 'complete',
      confidence: output.confidence,
      degraded,
      degraded_reason: degradedReason,
      prompt_tokens: usage?.prompt_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null,
      updated_at: now,
    };

    // Append-only ledger of this individual call, independent of the row
    // above — see recordEnrichmentCall for why it exists and why it is always
    // service-role-written. The worker path records the same entry per row.
    await recordEnrichmentCall({
      bookmarkId: bookmark.id,
      userId: bookmark.user_id,
      usage,
      degraded,
      degradedReason,
    });

    // Atomic single-row upsert keyed by the unique ai_enrichments.bookmark_id.
    // The preflight skip above wins the common (sequential) case; this handles
    // the rare race where the app and server triggers both pass the check before
    // either writes — ON CONFLICT updates in place instead of inserting a second
    // row, so the one-row-per-bookmark invariant holds without a follow-up read.
    // created_at is intentionally omitted: the column default fills it on insert
    // and merge-duplicates leaves it untouched on update.
    const saveRes = await rest(`/ai_enrichments?on_conflict=bookmark_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    });

    if (!saveRes.ok) {
      return json({ error: 'Failed to save enrichment' }, saveRes.status);
    }
    const [saved] = (await saveRes.json()) as unknown[];
    return json(saved, 200);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Enrichment failed' },
      500,
    );
  }
});
