import type {
  EnrichmentMetadataHint
} from "@/api/bookmarks";
import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import { jwtSubject } from "@/domain/jwt";
import { isTransientNetworkError } from "@/domain/network-errors";
import type {
  AIEnrichment,
  Bookmark, LocalPendingBookmark
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import { repository } from "@/storage/repository";
import { AI_QUOTA_DAILY_COOLDOWN_MS, AI_QUOTA_HOURLY_COOLDOWN_MS, AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S, AI_RATE_LIMITED, ENQUEUE_RLS_RETRY_DELAY_MS } from '@/store/bookmarks/constants';
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import { SupabaseRequestError } from "@/supabase/client";
import type { SupabaseAuthSession } from "@/supabase/types";
import {
  createSyncApi
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  auth: ReturnType<typeof useSupabaseAuth>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  aiEnriching: RefObject<Set<string>>;
  resetEpoch: RefObject<number>;
  setEnrichingIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setManualEnrichingIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  syncPausedRef: RefObject<boolean>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
  deferAiEnrichmentUntilSync: (bookmarkId: string) => void;
  aiTriggerAttempted: RefObject<Set<string>>;
  localeRef: RefObject<"en" | "ko">;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  clearAiRetry: (bookmarkId: string) => void;
  clearAiServerQueued: (bookmarkId: string) => void;
  aiSuggestionsModeRef: RefObject<AiSuggestionsMode>;
  autoAcceptEnrichmentRef: RefObject<((bookmarkId: string, enrichment: AIEnrichment) => Promise<void>) | null>;
  noteUnseenSuggestions: (enrichment: AIEnrichment) => void;
  armAiRetry: (bookmarkId: string) => Promise<boolean>;
  clearPendingAiTrigger: (id: string) => Promise<void>;
  lastSyncedUserId: RefObject<string | null>;
  wasAnonymousRef: RefObject<boolean | null>;
  aiQuotaCooldownUntil: RefObject<number>;
  setAiQuotaExceeded: Dispatch<SetStateAction<{ reason: string; retryAt: number; } | null>>;
  enrichmentsRef: RefObject<AIEnrichment[]>;
  markAiServerQueued: (bookmarkId: string) => void;
  syncAiRetryIds: () => void;
}

export function useAiEnrichmentRequest({
  auth,
  bookmarksRef,
  hasSyncedOnce,
  aiEnriching,
  resetEpoch,
  setEnrichingIds,
  setManualEnrichingIds,
  queueRef,
  syncPausedRef,
  syncNowRef,
  deferAiEnrichmentUntilSync,
  aiTriggerAttempted,
  localeRef,
  setEnrichments,
  clearAiRetry,
  clearAiServerQueued,
  aiSuggestionsModeRef,
  autoAcceptEnrichmentRef,
  noteUnseenSuggestions,
  armAiRetry,
  clearPendingAiTrigger,
  lastSyncedUserId,
  wasAnonymousRef,
  aiQuotaCooldownUntil,
  setAiQuotaExceeded,
  enrichmentsRef,
  markAiServerQueued,
  syncAiRetryIds,
}: Dependencies) {

  // Ask the backend to (re)generate AI suggestions for a synced bookmark. The
  // edge function writes the enrichment and returns it, so we surface results
  // immediately rather than waiting for the next pull. Fire-and-forget safe:
  // failures (e.g. the function isn't deployed yet) just return a message.
  const requestAiEnrichment = useCallback(
    async (
      bookmarkId: string,
      source: "auto" | "manual" | "preview" = "manual",
      overrideMetadata?: EnrichmentMetadataHint,
    ): Promise<string | null> => {
      if (!auth.session) {
        return "AI suggestions need the cloud — Supabase is not available right now.";
      }
      // The id may come from a queued dispatch (the stagger drain, a retry
      // check) that outlived its bookmark — deleted, or wiped by a library
      // reset. Don't fetch suggestions for a row that no longer exists
      // locally; report success so stale trigger markers get cleaned up. Must
      // run BEFORE hasSyncedOnce: that check can't tell "gone" from "never
      // synced" (both read as "no bookmark found"), and this one needs to win.
      if (!bookmarksRef.current?.some((item) => item.id === bookmarkId)) {
        return null;
      }
      if (!hasSyncedOnce(bookmarkId)) {
        return "AI suggestions are available once this bookmark has synced.";
      }
      if (aiEnriching.current.has(bookmarkId)) {
        // A Preview Refresh must retain its durable replacement marker when a
        // pre-refresh request is already running; `null` means this call
        // actually generated a fresh enrichment.
        return source === "preview" ? "enrichment_in_flight" : null;
      }
      // Library-reset race guard: snapshot the epoch now; every settle path
      // below re-checks it and discards if a reset completed meanwhile.
      const epochAtStart = resetEpoch.current;
      aiEnriching.current.add(bookmarkId);
      setEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      if (source === "manual") {
        setManualEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      }
      // Hoisted above the try/catch so the 429 handler below can enqueue the
      // overflow-queue insert with the SAME freshly-ensured session the
      // request itself used, instead of falling back to the possibly-stale
      // `auth.session` (see the comment on the assignment below for why that
      // matters — reusing it there caused the enqueue's own RLS check to
      // reject the insert (STASH-49): `pending_ai_enrichment`'s policy
      // requires `auth.uid()` to match the row, and a stale `auth.session`
      // can resolve to a different auth context than the one this call
      // proved was current).
      let session: SupabaseAuthSession | null = null;
      try {
        // The edge function forwards this access token to PostgREST, which 401s
        // on a stale one. The token can expire while the app sits idle, so
        // refresh it before the call (as the sync paths do) instead of reusing
        // the possibly-expired `auth.session`.
        session = (await auth.ensureAnonymousSession()) ?? auth.session;
        if (!session) {
          return "AI suggestions need the cloud — Supabase is not available right now.";
        }
        // Send the device's freshest metadata: the cloud row can still be a bare
        // URL (on-device OpenGraph enrichment may not have synced yet), and the
        // model would otherwise have nothing to reason about.
        const latest = bookmarksRef.current?.find(
          (item) => item.id === bookmarkId,
        );
        // If the bookmark has unsynced work (e.g. an un-uploaded folder move),
        // flush sync so the cloud row reflects the user's latest organizational state.
        const queuedEntry = queueRef.current.find(
          (entry) => entry.local_id === bookmarkId,
        );
        const hasUnsyncedWork =
          Boolean(queuedEntry) || (latest ? latest.sync_status !== "synced" : false);
        if (hasUnsyncedWork && !syncPausedRef.current) {
          try {
            await syncNowRef.current?.();
          } catch {
            // Best effort: proceed to check if upload succeeded
          }
        }
        // Queue payloads intentionally omit unchanged fields, so an unfile
        // update has `{}` and cannot be identified from `collection_id` alone.
        // Any queued local mutation may therefore make this device's folder
        // state newer than the cloud row. Wait for it rather than allowing the
        // function (or its overflow worker) to reason from stale cloud state.
        const stillUnsynced =
          queueRef.current.some((entry) => entry.local_id === bookmarkId) ||
          (bookmarksRef.current?.find((item) => item.id === bookmarkId)?.sync_status !== "synced");
        if (stillUnsynced) {
          // This durable marker preserves a deferred Preview Refresh as well
          // as normal automatic work, without consuming the failure budget.
          deferAiEnrichmentUntilSync(bookmarkId);
          aiTriggerAttempted.current.delete(bookmarkId);
          return source === "manual"
            ? "This bookmark must finish syncing before generating AI suggestions."
            : "sync_deferred";
        }
        const metadata: EnrichmentMetadataHint | undefined = latest
          ? {
            title: overrideMetadata?.title ?? latest.title,
            description: overrideMetadata?.description ?? latest.description,
            notes: overrideMetadata?.notes ?? latest.notes,
            site_name: overrideMetadata?.site_name ?? latest.site_name,
            content_type: overrideMetadata?.content_type ?? latest.content_type,
            // With no queued local mutation, the server row is newer or
            // equal. Never send a cached null that could overwrite a folder
            // another device assigned meanwhile.
            ...(overrideMetadata?.collection_id !== undefined
              ? { collection_id: overrideMetadata.collection_id }
              : {}),
          }
          : overrideMetadata;
        const activeLocale = localeRef.current;
        let enrichment: AIEnrichment;
        try {
          enrichment = await createSyncApi(session).requestEnrichment(
            bookmarkId,
            metadata,
            activeLocale,
          );
        } catch (error) {
          // If the server still rejects the token (rotation / clock skew),
          // force a refresh and retry once before surfacing the error.
          if (error instanceof SupabaseRequestError && error.status === 401) {
            const refreshed =
              (await auth.ensureAnonymousSession(true)) ?? session;
            // Codex review (PR #649): this used to retry with `refreshed`
            // but leave the outer `session` pointing at the rejected one —
            // so if this retry itself came back 429, the 429 handler below
            // would enqueue with the SAME session PostgREST just 401'd,
            // rather than the one that actually reached the rate-limit
            // check. Reassign so every later use of `session` (including
            // the enqueue diagnostics) reflects what this call actually used.
            session = refreshed;
            enrichment = await createSyncApi(refreshed).requestEnrichment(
              bookmarkId,
              metadata,
              activeLocale,
            );
          } else {
            throw error;
          }
        }
        // A library reset completed while this request was in flight: the
        // bookmark (and its cloud row) are gone, so discard the result rather
        // than resurrect an enrichment for it in the just-cleared state.
        if (resetEpoch.current !== epochAtStart) {
          return null;
        }
        // Newest enrichment for this bookmark wins (getEnrichment also picks newest).
        setEnrichments((current) => [
          enrichment,
          ...current.filter((item) => item.bookmark_id !== bookmarkId),
        ]);
        try {
          await ensureRepositoryReady();
          await repository.upsertEnrichments([enrichment]);
        } catch (error) {
          logStorageError("ai enrichment", error);
        }
        // A written enrichment row means this bookmark no longer needs a
        // retry — clear any armed marker from an earlier failed attempt
        // (auto or manual; unified — see armAiRetry below).
        clearAiRetry(bookmarkId);
        // Covers a later attempt (local retry, manual tap) succeeding
        // directly rather than via the overflow queue's delivery: this
        // bookmark no longer needs the "queued, will arrive automatically"
        // note either, since it just arrived right here.
        clearAiServerQueued(bookmarkId);
        // STASH #573 auto_accept mode: apply high-confidence tag/folder
        // suggestions with no review step. Runs AFTER the enrichment is
        // durably recorded and retry state is cleared, and in its own
        // try/catch: this is a convenience layered on top of an already-
        // successful fetch, so a bug here (e.g. a failed createCollection
        // call) must never make a genuinely successful enrichment look like
        // a failed attempt (which would both discard the fetched enrichment
        // above — it never happened, the write already landed — and wrongly
        // arm a retry for a request that actually succeeded).
        if (aiSuggestionsModeRef.current === "auto_accept") {
          try {
            await autoAcceptEnrichmentRef.current?.(bookmarkId, enrichment);
          } catch (error) {
            recordLog(
              "warn",
              `ai-enrich auto_accept failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // A background auto-enrichment lands without the user looking at this
        // bookmark, so flag it for the Inbox "new suggestions" banner. A manual
        // "Suggest with AI" tap happens on the Detail screen — the user is
        // already witnessing it — so it doesn't (and Detail clears the flag).
        // In auto_accept mode this only fires for whatever auto-accept left
        // behind (e.g. a pending summary — auto-accept never touches notes).
        if (source === "auto" || source === "preview") {
          noteUnseenSuggestions(enrichment);
        }
        return null;
      } catch (error) {
        // A library reset completed while this request was in flight: the
        // bookmark is gone, so record nothing — no retry marker, no overflow
        // enqueue — or the reset's just-emptied bookkeeping gets repopulated.
        if (resetEpoch.current !== epochAtStart) {
          return error instanceof Error
            ? error.message
            : "Could not generate AI suggestions.";
        }
        // Any failure here writes no ai_enrichments row: arm (or re-arm) this
        // bookmark's backoff-scheduled retry marker regardless of source, so a
        // failed manual "Suggest with AI" tap is retried the same as a failed
        // auto-trigger (unifying what used to be auto-only bookkeeping).
        // Awaited: the replacement marker's write must be durably confirmed
        // before the pending-trigger marker below is even issued for removal
        // — otherwise a process kill between two unawaited fire-and-forget
        // writes could still leave storage with the trigger cleared and the
        // retry marker never written, reopening the crash window this
        // ordering exists to close (see armAiRetry/persistAiRetryState).
        const retryStateArmed = await armAiRetry(bookmarkId);
        // The crash-safety marker (PENDING_AI_TRIGGER_KEY) only needs to
        // survive from launch until this first attempt's outcome is durably
        // recorded — success clears it below in the settle handler; failure
        // now has its durable trace in `ai_suggestion_retry` via armAiRetry
        // above, so clear it here too. Otherwise a relaunch inside the
        // backoff window rehydrates it and the deferred first-trigger effect
        // fires `requestAiEnrichment` again immediately, bypassing the whole
        // backoff schedule on every restart. But only once armAiRetry's write
        // is confirmed — if it didn't actually land, clearing this now would
        // leave nothing durable recording the failed attempt at all, and a
        // relaunch inside the backoff window would silently never retry.
        if (retryStateArmed) {
          await clearPendingAiTrigger(bookmarkId);
        }
        // Rate limited (429): expected when many bookmarks are captured at once.
        // Return a sentinel the Detail screen (still) localizes into a calm
        // message pending its own follow-up UI change.
        if (error instanceof SupabaseRequestError && error.status === 429) {
          // STASH-4K follow-up: a 429 here always means the per-user quota is
          // exhausted (the only failure mode this endpoint returns 429 for)
          // — pause the staggered AUTO drain so a large backlog doesn't keep
          // firing requests that are each a guaranteed repeat of this same
          // rejection. Manual "Suggest with AI" taps bypass this (see the
          // drain effect below, which only gates the auto path).
          // Codex review (round 2, PR #655): a request started under account A
          // can still be in flight when the user switches to account B — the
          // account-switch effect clears the cooldown first, but this stale
          // A response would then arm a fresh one and wrongly throttle B.
          // Only apply it if the account that made this request is still the
          // active one (lastSyncedUserId.current — the same ref the
          // account-switch effect itself updates). Codex review (PR #664):
          // an anonymous request can still be in flight when OAuth linking
          // completes — id-only equality still matches (linking preserves
          // the id), so also require the captured session's anonymity to
          // match wasAnonymousRef.current (kept live by the link-clear
          // effect below, same forward-reference-via-ref pattern as
          // autoAcceptEnrichmentRef) rather than reading `auth.session`
          // directly here — this callback's own closure can be just as
          // stale as `session` itself if it was created before the link
          // completed. Without this, a late anonymous-quota 429 would
          // repopulate aiQuotaExceeded with the just-upgraded account's
          // obsolete (10/hr, 50/day) limits right after the link effect
          // cleared it.
          //
          // Codex review round 2: `lastSyncedUserId.current` is only reset
          // by an actual NEW sign-in, not by a session disappearing
          // (session_expired / signed-out with nothing minted yet) — so it
          // still matches the departed user's id in that case. Coalescing
          // `wasAnonymousRef.current` to `false` when it's `null` (no
          // current session at all) would then falsely "match" a captured
          // non-anonymous session's `is_anonymous: false`, letting a late
          // 429 through with no live session to even own the resulting
          // cooldown/display state. Requiring `!== null` here (there IS a
          // current session) closes that, on top of the anonymity check.
          if (
            session &&
            session.user.id === lastSyncedUserId.current &&
            wasAnonymousRef.current !== null &&
            (session.user.is_anonymous !== false) === wasAnonymousRef.current
          ) {
            let cooldownMs = AI_QUOTA_HOURLY_COOLDOWN_MS;
            if (error.reason === "daily_limit") {
              cooldownMs = AI_QUOTA_DAILY_COOLDOWN_MS;
            } else if (
              typeof error.retryAfterSeconds === "number" &&
              error.retryAfterSeconds >=
              AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S.min &&
              error.retryAfterSeconds <=
              AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S.max
            ) {
              // Codex review (PR #655): the server computes this exactly for
              // hourly_limit — trust it instead of the fixed fallback so a
              // near-expired window doesn't idle the queue for minutes longer
              // than necessary, and a nearly-full hour doesn't get probed
              // before a slot can actually open.
              cooldownMs = error.retryAfterSeconds * 1000;
            }
            aiQuotaCooldownUntil.current = Date.now() + cooldownMs;
            // Display-only mirror (Settings backlog row, feedback
            // diagnostics): unlike `cooldownMs` above (deliberately capped so
            // the drain loop re-probes periodically rather than idling for a
            // full day), this uses the server's real retry_after verbatim —
            // accurate for both hourly_limit and daily_limit as of the
            // request_ai_enrichment_slot migration that computes it from the
            // oldest request in each window, not a flat guess.
            const displaySeconds =
              typeof error.retryAfterSeconds === "number" &&
                error.retryAfterSeconds > 0
                ? error.retryAfterSeconds
                : cooldownMs / 1000;
            setAiQuotaExceeded({
              reason: error.reason ?? "rate_limited",
              retryAt: Date.now() + displaySeconds * 1000,
            });
          }
          // STASH #578 Phase 2: instead of just returning the rate-limited
          // sentinel, enqueue this bookmark for the background overflow
          // worker to retry later. Fire-and-forget in the strictest sense —
          // wrapped in its own try/catch (not just a promise .catch(), since a
          // missing session or a synchronous throw must not escape either):
          // an enqueue failure must never change what the caller sees for
          // this 429, and is never retried here.
          // Only enqueue to the server-side overflow queue if the bookmark's local
          // mutations have uploaded. If the local row still has unsynced work in the
          // queue (pending, syncing, or failed) or sync_status !== 'synced',
          // the server worker would reason from the stale cloud row. In that case, let local
          // retry (armed via armAiRetry above) retry when sync resumes and the row uploads.
          const queuedEntry = queueRef.current.find(
            (entry) => entry.local_id === bookmarkId,
          );
          const currentBookmark = bookmarksRef.current?.find(
            (item) => item.id === bookmarkId,
          );
          const hasUnsyncedQueueWork =
            Boolean(queuedEntry) ||
            (currentBookmark ? currentBookmark.sync_status !== "synced" : false);
          if (session && !hasUnsyncedQueueWork) {
            // STASH-4D/4E: production keeps reporting "new row violates row-
            // level security policy for table pending_ai_enrichment" on this
            // insert even on builds carrying STASH-49's fix (this call
            // already reuses `session`, not the possibly-stale `auth.session`
            // — see the comment where `session` is assigned above). The same
            // session's token is independently proven valid moments earlier:
            // the edge function's forwarded-auth GET of this exact bookmark,
            // inside requestEnrichment above, just succeeded. Static review
            // of both call sites finds nothing further wrong, so capture
            // enough about the session actually used here — instead of
            // guessing a further fix — to tell "wrong identity" from
            // "empty/expired token" from "a session object requestEnrichment
            // didn't use" apart on the next occurrence.
            //
            // Codex review (PR #649) on the first cut of this diagnostic:
            // - `session === auth.session` is nearly always false even in
            //   the healthy case, since ensureAnonymousSession() restores
            //   from storage and allocates a fresh object every call — it
            //   can't distinguish "actually different" from "just
            //   re-deserialized". Compare the token VALUE instead.
            // - session.user.id is only what the JS session object claims;
            //   the RLS check evaluates auth.uid() from the access token's
            //   own `sub` claim. Decode it locally (jwtSubject — no
            //   atob/Buffer dependency, never logs the raw token) so a
            //   divergence between the two is directly visible instead of
            //   assumed away.
            // Field names here deliberately avoid "token"/"auth"/"session"/
            // "secret"/"credential" — Sentry's default project-level Data
            // Scrubber redacts (replaces with "[Filtered]") any value whose
            // containing field looks like one of those words, and since each
            // log line ships as one opaque string (not a structured object
            // Sentry can scrub key-by-key), a single matched word blanks the
            // WHOLE line — including the original error text before it. The
            // first cut of this diagnostic used exactly those words and every
            // occurrence came back as "[Filtered]" (STASH-4F), hiding even
            // the baseline message that used to be visible pre-#649.
            //
            // STASH-4G/4H: with the scrubbing fixed, real diagnostics came
            // back — and every field was healthy (correct owner, JWT sub
            // matches, not anonymous, same bearer as the reactive session,
            // ~an hour from expiry), repeated across a dozen+ failures. That
            // rules out every session-identity theory this diagnostic was
            // built to test. What's left of the insert policy is the OTHER
            // clause: `EXISTS (SELECT 1 FROM bookmarks WHERE id = bookmark_id
            // AND user_id = auth.uid())`. Since auth.uid() is now proven
            // correct, a failure there means THIS bookmark_id specifically
            // doesn't resolve — logging it is what actually lets that be
            // checked against the database on the next occurrence.
            const jwtSub = jwtSubject(session.access_token);
            const enqueueSessionDiagnostics = JSON.stringify({
              bookmarkId,
              enqueueOwnerId: session.user.id,
              jwtSubMatchesOwnerId:
                jwtSub === null ? null : jwtSub === session.user.id,
              ownerIsAnonymous: session.user.is_anonymous ?? null,
              reactiveOwnerId: auth.session?.user.id ?? null,
              bearerMatchesReactive:
                session.access_token === auth.session?.access_token,
              bearerLength: session.access_token?.length ?? 0,
              expiresAt: session.expires_at ?? null,
              secondsUntilExpiry:
                session.expires_at != null
                  ? session.expires_at - Math.floor(Date.now() / 1000)
                  : null,
            });
            // Snapshotted now (before the enqueue POST's round trip) so the
            // .then() below can detect a set-after-clear race: this call's
            // own aiEnriching guard releases in the `finally` below as soon
            // as this 429 branch returns, well before this un-awaited
            // promise settles — so a later call for the SAME bookmark (a
            // manual retry, which deliberately ignores backoff and fires
            // immediately) can start and even succeed in the meantime,
            // landing a real enrichment and calling clearAiServerQueued
            // (currently a no-op, since nothing is set yet). If this
            // confirmation then lands afterward and sets the marker
            // unconditionally, nothing would ever clear it again — the
            // sync-pull clear only fires for a strictly newer arrival, and
            // this bookmark is already done. Reference identity, not a
            // timestamp: `updated_at` is server time and has no reliable
            // relationship to the client clock at enqueue time, but every
            // write to `enrichments` (direct success or sync-pull) replaces
            // the array with fresh objects, so an unchanged reference here
            // reliably means "nothing arrived for this bookmark meanwhile".
            const enrichmentBeforeEnqueue = enrichmentsRef.current.find(
              (item) => item.bookmark_id === bookmarkId,
            );
            // CONFIRMED: the server durably accepted this bookmark into the
            // overflow queue, so the background worker will deliver a real
            // result via normal sync. Only set on this resolution — never
            // eagerly, and never from a failure branch, which falls back to
            // the generic armAiRetry marker above alone.
            //
            // But skip it if a real enrichment already landed for this
            // bookmark since the enqueue was fired (a faster manual retry,
            // or — in principle — an extremely fast worker delivery): marking
            // it queued now would strand a "will arrive automatically" note
            // on an already-complete bookmark forever. See the snapshot
            // comment above. Un-awaited, so this can also land AFTER a
            // library reset that ran while the enqueue round-tripped — in
            // which case the reference-equality check below would pass
            // vacuously (both sides undefined once the reset emptied the
            // cache) and strand a marker for a deleted bookmark. Same epoch
            // guard as the other settle paths.
            const enqueueSession = session;
            const attemptEnqueue = async (): Promise<void> => {
              await createSyncApi(enqueueSession).enqueuePendingEnrichment(
                bookmarkId,
                localeRef.current ?? undefined,
              );
              if (resetEpoch.current !== epochAtStart) {
                return;
              }
              const enrichmentNow = enrichmentsRef.current.find(
                (item) => item.bookmark_id === bookmarkId,
              );
              if (enrichmentNow === enrichmentBeforeEnqueue) {
                markAiServerQueued(bookmarkId);
              }
            };
            try {
              attemptEnqueue().catch(async (enqueueError: unknown) => {
                // STASH-4J: a single bounded retry for the specific failure
                // this diagnostic (STASH-4G/4H) already proved is transient
                // — an RLS violation (HTTP 403) with otherwise healthy
                // session/identity diagnostics and a bookmark that
                // demonstrably exists. Anything else (network failure, a
                // genuine permissions problem) logs immediately, unretried,
                // same as before.
                if (
                  !(enqueueError instanceof SupabaseRequestError) ||
                  enqueueError.status !== 403
                ) {
                  recordLog(
                    "warn",
                    `pending_ai_enrichment enqueue failed: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)} ${enqueueSessionDiagnostics}`,
                  );
                  return;
                }
                await new Promise((resolve) =>
                  setTimeout(resolve, ENQUEUE_RLS_RETRY_DELAY_MS),
                );
                try {
                  await attemptEnqueue();
                } catch (retryError) {
                  recordLog(
                    "warn",
                    `pending_ai_enrichment enqueue failed after retry: ${retryError instanceof Error ? retryError.message : String(retryError)} ${enqueueSessionDiagnostics}`,
                  );
                }
              });
            } catch (enqueueError) {
              recordLog(
                "warn",
                `pending_ai_enrichment enqueue threw: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)} ${enqueueSessionDiagnostics}`,
              );
            }
          }
          return AI_RATE_LIMITED;
        }
        // Anything else is a genuine failure the user can't act on (e.g. the
        // ai-enrich edge function returning 400/500). It was only ever surfaced
        // in the Detail UI; record it so it also lands in the in-app diagnostics
        // buffer and reaches Sentry (URL/email-scrubbed at the bridge), the way
        // preview-fetch failures already do — otherwise an outage is invisible.
        const detail = error instanceof Error ? error.message : String(error);
        const isHttpError = error instanceof SupabaseRequestError;
        const status = isHttpError ? ` (HTTP ${error.status})` : "";
        // A raw client-side transport failure (device offline, DNS unresolved)
        // never reached the function — an expected condition, not an outage — so
        // log it as a warn breadcrumb instead of an error that forwards to Sentry
        // and floods the issue stream (STASH-4). A SupabaseRequestError means the
        // function actually responded with an error status: a genuine server/
        // function failure that stays at 'error' even when its body echoes a
        // transport-looking message (e.g. the function's own upstream fetch failed).
        const level =
          !isHttpError && isTransientNetworkError(error) ? "warn" : "error";
        recordLog(level, `ai-enrich failed${status}: ${detail}`);
        return error instanceof Error
          ? error.message
          : "Could not generate AI suggestions.";
      } finally {
        aiEnriching.current.delete(bookmarkId);
        const remove = (prev: ReadonlySet<string>): ReadonlySet<string> => {
          if (!prev.has(bookmarkId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(bookmarkId);
          return next;
        };
        setEnrichingIds(remove);
        if (source === "manual") {
          setManualEnrichingIds(remove);
        }
        // Refresh the reactive retry-id mirror in this same synchronous block
        // as the isEnriching flip above (see aiRetryIds' declaration comment)
        // — armAiRetry/clearAiRetry above have already updated the ref.
        syncAiRetryIds();
      }
    },
    [
      auth,
      noteUnseenSuggestions,
      armAiRetry,
      clearAiRetry,
      syncAiRetryIds,
      clearPendingAiTrigger,
      markAiServerQueued,
      clearAiServerQueued,
      hasSyncedOnce,
      deferAiEnrichmentUntilSync,
    ],
  );
  return { requestAiEnrichment };
}
