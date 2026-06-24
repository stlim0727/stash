# Project-wide review — Stash (the "Grumpy" pass)

**Scope:** whole repo, reviewed at five levels — architecture/data-integrity,
backend/security, mobile UI/share, tests/tooling/CI/docs, and the `.claude/agents`
persona files themselves.
**Status:** Analysis only — **no code changes in this PR.** Findings are claims to
be confirmed by the owning area before any fix lands.

> Produced by an adversarial reviewer persona ("Grumpy Smurf"): no praise, every
> finding carries `file:line` + why it bites + a one-line fix, verified against the
> code rather than asserted from memory. Five reviewers ran in parallel, one per
> level; this is the consolidated, worst-first result.
>
> The point of this doc is the **PR thread**: each specialist area is expected to
> review its own findings below, confirm/dispute, and comment. Treat severities as
> a starting proposal, not a verdict.

---

## Consolidated priority (cross-level)

The five passes converge on one theme: the newer **public API / `claude-proxy`
surface is a blind spot** across security, ownership, and verification.

| # | Finding | Level | Owner |
|---|---------|-------|-------|
| 🔴 1 | `claude-proxy` is an unmetered, unvalidated proxy to a billable Anthropic key | Backend/Security | backend-security |
| 🔴 2 | `public-api` PostgREST filter injection via `q` / `collection_id` (+ unescaped `inFilter`) | Backend/Security | backend-security |
| 🟠 3 | `ai-enrich` rate limiter fails **open** | Backend/Security | backend-security |
| 🟠 4 | Trashed-before-sync create uploads as active; reconcile omits `deleted_at` → row resurrects in cloud / on other devices ([corrected](#correction-log)) | Architecture | domain-sync |
| 🟠 5 | anon→real carry-over loses **tags** (`collection_id`/`is_archived` self-heal via reconcile — [corrected](#correction-log)) | Architecture | domain-sync |
| 🟡 6 | `verify-supabase.mjs` still asserts archive-as-delete (contradicts move-to-trash) | Tests/Docs | backend-security |
| 🟡 7 | `api/bookmarks.ts` (876 LOC) + repository queue engine have zero unit tests | Tests | domain-sync |

---

## Level 1 — Architecture & data integrity

**[HIGH] Trash state is lost on sync — a bookmark trashed before it syncs stays active in the cloud and resurrects on other devices.** `apps/mobile/src/store/bookmarks.tsx:1756-1765` + `apps/mobile/src/sync/create-payload.ts:18-31`.
> **Correction (post-Codex + code verification):** the original diagnosis blamed
> `repository.native.ts:182` (`replaceBookmark` dropping the `deleted_at` column).
> That is a real omission, but it does **not** resurrect anything locally:
> `getBookmarks` reads via `JSON.parse(row.data)` (`repository.native.ts:159-162`)
> and the store's active/trash filters key off `bookmark.deleted_at` from that JSON,
> so the indexed column being NULL is inert on device. The real bug is on the **sync
> path**: a local `create` trashed before it gains a remote id uploads as an *active*
> create (`createPayloadFromBookmark` omits `deleted_at`), and the post-create
> reconcile condition (`bookmarks.tsx:1756-1765`) checks `is_archived`/`collection_id`/
> edits/metadata but **not** `deleted_at` — so the cloud row stays active and the next
> pull on another device sees it live.
*Fix:* add `deleted_at` to the reconcile condition (enqueue a follow-up `update`/`delete`
when the persisted row is trashed) and carry trash state through the create path.
Adding the column to `replaceBookmark` is harmless tidy-up, not the fix.

**[MEDIUM] anon→real carry-over loses **tags** (not collection/archive).** `apps/mobile/src/sync/account-transition.ts:96-124`.
> **Correction (post-Codex + code verification):** the original finding claimed
> `collection_id`/`is_archived`/tags were all dropped and the reconcile was
> "bypassed". Wrong on two counts: re-homed rows keep `collection_id`/`is_archived`
> in their local record (`...old` spread, `:98`) and their fresh `create` flows
> through the **same** post-create reconcile (`bookmarks.tsx:1756`), which fires a
> follow-up `update` when those fields diverge — so they reach the cloud one sync
> round later (eventually-consistent, not lost).
The genuinely-lost state is **tags**: `pendingTagOps` are keyed by `bookmark_id`,
re-home swaps the row to a new `local-*` id without re-keying the ops, so they fire
`addTags` against an id that no longer exists in the new account → orphaned.
*Fix:* re-key `pendingTagOps` old→new id in `applyAccountTransition` (the re-home
loop already has both ids). Touches account-transition semantics → add a test +
a note in `docs/architecture/sync-account-switching.md`.

**[MEDIUM] `apps/mobile/src/sync/pull-bookmarks.ts:155-157` vs `bookmarks.tsx:1806` — the deletion guard depends on read-before-write ordering nobody enforces.**
The "is this an account switch?" decision is computed twice and independently
(once in `syncNow`, once inside `pullRemoteChanges`), both reading
`SYNCED_USER_ID_KEY`, which is only written inside `pullRemoteChanges`. Works
today, fragile tomorrow: any reorder makes `userChanged` read false, skip the
guard, and wipe the previous account's not-yet-re-homed rows as "deleted remotely."
*Fix:* compute `userChanged` once in `syncNow` and pass it explicitly into `pullRemoteChanges`.

**[MEDIUM] `apps/mobile/src/sync/account-transition.ts:35-75` — `plan.resetWatermark` is computed, asserted in tests, and never applied.**
`applyAccountTransition:84-133` never reads it; the watermark only resets as a side
effect of the pull recomputing `userChanged`. The tests
(`account-transition.test.ts:42,68,80`) validate a field that does nothing.
*Fix:* honor `plan.resetWatermark` in `applyAccountTransition` (clear `LAST_PULLED_AT_KEY`) and make it the single source, or delete the dead field + asserts.

**[MEDIUM] `apps/mobile/src/sync/pull-bookmarks.ts:108` — last-write-wins uses string `>` on `updated_at`; ties go to local, dropping same-tick cross-device edits.**
Lexicographic compare misorders timezone-offset or differing-precision timestamps,
and an exact-millisecond tie makes the remote lose unconditionally.
*Fix:* compare `Date.parse(...)` and pick a deliberate tie-breaker.

**[LOW] `apps/mobile/src/sync/sync-bookmarks.ts:27-37` — `removeQueueEntryIfNotSuperseded` checks only `operation`, so update→update supersession is wrongly deleted.**
A second update enqueued mid-sync (e.g. enrichment landing at `bookmarks.tsx:662`)
has the same `operation`, so the finished in-flight entry deletes the newer pending
update; freshly-enriched metadata never uploads until another mutation re-triggers.
*Fix:* supersede on identity (sequence / `updated_at`), not operation.

**[LOW] `apps/mobile/src/store/bookmarks.tsx:1062-1063 / 973-974` — optimistic insert + enqueue can partially fail (no atomic transaction).**
If `enqueue` throws while `insertBookmark` succeeded inside the same `Promise.all`,
durable state is half-written and undetectable; the orphan reconciler handles
"bookmark without queue entry" but not the reverse.
*Fix:* insert + enqueue in one repository transaction (`withTransactionAsync` exists).

---

## Level 2 — Backend & security

**[CRITICAL] `supabase/functions/claude-proxy/index.ts:73-84` — unmetered, unvalidated proxy to a billable Anthropic key.**
Any `stash_` key holder POSTs an arbitrary body forwarded verbatim to
`api.anthropic.com` with the operator's `ANTHROPIC_API_KEY`. No rate limit, no
model allowlist, no `max_tokens` cap, no body validation. One leaked/abused
anon-minted key = unbounded spend, any model, any token count.
*Fix:* gate via `request_ai_enrichment_slot_for(user_id)` (or a per-key limiter),
whitelist `model`, clamp `max_tokens` before forwarding.

**[HIGH] `supabase/functions/public-api/index.ts:183-184` — PostgREST filter injection via `q` and `collection_id`.**
`query` is interpolated raw into `or=(title.ilike.*${query}*,…)` and `collectionId`
into `eq.${collectionId}`. The mobile client deliberately strips `[%*,()]`
(`bookmarks.ts:719`); the public API does not. PostgREST decodes and parses `,`/`)`
structurally, so `q=foo),is_archived.eq.false` breaks out of the group. Rows stay
`user_id`-scoped (no cross-tenant), but it's a within-account filter-bypass.
*Fix:* apply the same strip to `query`; validate `collection_id` is a UUID.

**[HIGH] `supabase/functions/public-api/index.ts:152-154` — `inFilter()` interpolates values with no quoting/escaping.**
Returns `(${values.join(',')})`, unlike the hardened mobile copy
(`bookmarks.ts:180-182`). Server-derived UUIDs today, but one refactor from taking
user input — and the divergence is itself the trap.
*Fix:* port the quoting `inFilter` from `bookmarks.ts`.

**[HIGH] `supabase/functions/ai-enrich/index.ts:254-257` — rate limiter fails OPEN.**
Any non-OK/thrown RPC result logs and proceeds to the billable model. Combined with
anonymous-first sign-ups, a single DB hiccup removes the only cost control.
*Fix:* fail closed (429/503) when the verdict can't be obtained, at least on the anon path.

**[MEDIUM] `apps/mobile/src/supabase/oauth.ts:57-71` / `run-oauth.ts:42-94` — OAuth flow has no `state` parameter.**
`buildAuthorizeQuery` sends only `provider/redirect_to/code_challenge`;
`parseAuthRedirect` reads only `code`/`error`. No CSRF `state` generated or
verified; PKCE protects the code exchange but nothing binds the redirect to this attempt.
*Fix:* generate a random `state`, include it, reject mismatches.

**[MEDIUM] `supabase/migrations/20260623000000_trash_and_app_config.sql:24-26` — `app_config` is world-readable via `using (true)`.**
Anon SELECT, no key scoping. Only `min_app_version` today, but any future config key
is immediately public.
*Fix:* scope to `using (key = 'min_app_version')`.

**[LOW] `public-api/index.ts:24-28` (and `claude-proxy:14-18`, `api-keys:19-23`) — `Access-Control-Allow-Origin: *` on bearer-authenticated APIs.**
Wildcard CORS + `Allow-Headers: Authorization` lets any web origin drive a victim's pasted key.
*Fix:* reflect an allowlisted origin, or drop CORS for machine-to-machine endpoints.

**[LOW] `apps/mobile/src/supabase/session-storage.native.ts:47-57` — refresh token stored in plaintext SQLite.**
Full session (incl. `refresh_token`) `JSON.stringify`'d into unencrypted `stash-auth.db`.
*Fix:* store at least the refresh token in expo-secure-store / Keychain.

**[LOW] `scripts/check-static-env.mjs:15` — env guard is form-only and comment-bypassable.**
`/process\.env\s*(\?\.)?\s*\[/` catches only dynamic indexing; it does not stop a
static non-`EXPO_PUBLIC_` reference, and the `//` skip can be gamed.
*Fix:* also flag `process.env.<NAME>` where `<NAME>` isn't `EXPO_PUBLIC_*` (or `NODE_ENV`).

---

## Level 3 — Mobile UI & share-capture

**[MEDIUM] `apps/mobile/src/share/share-intent-handler.tsx:61,138` — dead `behavior` ref with a lying comment.**
The ref is declared and written but never read; the comment sells a cache that
"takes effect on the next share without blocking on storage," yet every share calls
`getPreference(...)` fresh.
*Fix:* delete the ref, or actually read `behavior.current` as the fallback when `getPreference` throws.

**[MEDIUM] `apps/mobile/src/share/share-intent-handler.tsx:180` — `addBookmark` in the save-effect deps invites re-entrancy.**
Re-entrancy is guarded only by a single synchronous state nulling, not the dep array.
*Fix:* capture the share in a ref and gate on a `consumedRef`.

**[LOW] `apps/mobile/src/app/add.tsx:23` — manual Add is stricter than share about URL parsing.**
Raw state to `addBookmark`; `normalizeUrl` rejects interior whitespace, but the
share path got `extractFirstUrl` salvage and the manual form did not — inconsistent leniency.
*Fix:* run manual input through `extractFirstUrl` (or trim + strip trailing fragment) before validating.

**[LOW] `apps/mobile/src/app/+not-found.tsx:18-26` — `canGoBack()` sampled once at render can strand the user on a blank screen.**
On cold start the stack may not be ready; a stale `true` + a no-op `router.back()`
renders `null` forever — bad for the `stash://` deep-link absorber.
*Fix:* redirect to `/` on cold-start uncertainty, or gate on a stable `useRootNavigationState()` ready flag.

**[LOW] `apps/mobile/src/app/_layout.tsx:68-69` — "no-op on web" rests on a dependency, not a guard.**
`ShareIntentHandler`/`ShareConfirmHandler` mount unconditionally; web-safety relies
on the expo-share-intent shim.
*Fix:* early-return `null` from both when `Platform.OS === 'web'`.

**[LOW] `apps/mobile/src/share/share-intent-handler.tsx:131-179` — post-save IIFE is fire-and-forget; a throw is an unhandled rejection with no error path.**
*Fix:* wrap in try/catch with a `router.replace('/')` fallthrough, or attach `.catch(reportError)`.

---

## Level 4 — Tests, tooling, CI & docs

**[HIGH] `apps/mobile/src/api/bookmarks.ts` (876 LOC) — the user-scoped REST surface has zero direct tests.**
The whole `api/` dir has no `*.test.ts`; the exact layer where a missing `user_id`
filter leaks/clobbers other users' rows is exercised only by the secret-gated,
CI-skipped `verify:supabase`.
*Fix:* add a Node-lane test asserting request URLs/filters (`user_id=eq.`, select columns, upsert idempotency key) with a fetch fake.

**[HIGH] `package.json:18` — CI never runs a real linter.**
`pnpm lint` = whitespace/newline + env check. No ESLint; `apps/mobile/package.json:49`
defines an uninvoked `expo lint`, implying linting exists.
*Fix:* wire a real ESLint into CI, or delete the misleading script and rename root `lint`→`format:check`.

**[MEDIUM] `apps/mobile/src/storage/repository.native.ts` + `repository.ts` — the persistence + queue engine has no unit tests.**
The supersede/coalesce invariant ("newer mutations supersede older") is the heart of
local-first correctness and nothing asserts it; the Node lane can only see the web
repository, never the shipping `.native.ts`.
*Fix:* extract queue-coalescing into a pure module and unit-test it; gate the native path with `expo export --platform ios` in CI.

**[MEDIUM] `CLAUDE.md:45` — "deletes archive by default" is stale (now move-to-trash via `deleted_at`).**
*Fix:* "deletes move to trash (`deleted_at`); archive is separate."

**[MEDIUM] `scripts/alias-loader.mjs:4` — doc comment names the wrong Node flag (`--experimental-strip-types` vs the `--experimental-transform-types` actually used).**
*Fix:* correct the comment.

**[MEDIUM] `CLAUDE.md:18` — "16-check" undercounts `verify-supabase.mjs` (~17–19 checks).**
*Fix:* drop the magic number.

**[LOW] `.github/workflows/ci.yml:21` + `package.json:20` — `pnpm test` uses `&&`, so a failing mobile lane short-circuits and `test:functions` never runs.**
*Fix:* split into separate CI steps so both lanes always report.

**[LOW] `package.json:23-25` — `verify:sentry`, `dedupe:supabase` are undocumented; `dedupe:supabase` rewrites rows (destructive) yet is invisible in the "source of truth" docs.**
*Fix:* document them and flag the destructive one.

---

## Level 5 — The `.claude/agents` persona files

**[HIGH] `.claude/agents/chief-of-staff.md:45` — escalation via `AskUserQuestion` won't reach the user when chief-of-staff itself runs as a subagent.**
A nested persona's "questions" return to the caller, not the human, silently
defeating the escalation section.
*Fix:* "stop and return the decision to your caller/the user as an explicit question" — escalation is a hand-back, not a tool call.

**[HIGH] `.claude/agents/backend-security-engineer.md:41` — repeats the stale "verify:supabase (16-check)" count (actually ~17).**
A persona that says "verify, don't assume" shouldn't parrot an unverified number.
*Fix:* drop the number or correct it, and fix `CLAUDE.md:18`.

**[MEDIUM] `.claude/agents/backend-security-engineer.md:33` + `scripts/verify-supabase.mjs:231` — the persona endorses a verify script that still asserts `archive-by-default delete`, contradicting the new move-to-trash rule.**
A backend engineer told to run it gets a green check that contradicts the product rule.
*Fix:* fix the script's delete check to assert `deleted_at` soft delete.

**[MEDIUM] `.claude/agents/backend-security-engineer.md:17 — names only `ai-enrich` + `feedback-bridge`; `supabase/functions/` actually has five (`api-keys`, `claude-proxy`, `public-api` too).**
The three unnamed functions are exactly the ones with the CRITICAL/HIGH findings —
nobody's territory explicitly covers them.
*Fix:* "all functions under `supabase/functions`".

**[MEDIUM] `.claude/agents/chief-of-staff.md:23,30-33` — the "invoke specialists in parallel" model only works at top level; a nested Task-spawned agent has no Agent tool to fan out.**
*Fix:* state "this persona runs at the top level; it cannot be nested."

**[LOW] `.claude/agents/mobile-ui-engineer.md:18-20` — "routes to Inbox" flattens a two-mode flow (toast-mode stays put unless tapped).**
*Fix:* "saves, confirms via the capture toast, and either stays put or jumps to Inbox per the share-behavior setting — no editor."

**[LOW] `.claude/agents/chief-of-staff.md:24` — references `release/0.1.x` as if it exists; no such branch is in the repo (created on demand for the first 0.1.x patch).**
*Fix:* note it's created on demand.

**[LOW] `.claude/agents/grumpy-smurf.md` — passes its own read-only/name checks, but never tells itself to open files before citing — risking stale `file:line` from memory.**
*Fix:* add "every `file:line` must be one you actually read this session."

---

## Verdict

The RLS migrations and the capture path are competently built. But the bolted-on
`public-api` + `claude-proxy` are an unmetered Anthropic-billing faucet and a
filter-injection playground, the rate limiter fails open, OAuth ships with no
`state`, trashed bookmarks resurrect on sync, anonymous users lose their
collections the moment they sign in — and the 876-line user-scoped API plus the
whole sync-queue engine coast on zero unit tests behind a "lint" that only trims
whitespace, while the docs describe a codebase that no longer exists.

**Fix the facts (docs/persona/verify script), lock the faucet (`claude-proxy`),
then bury the zombie bookmarks — before this goes near production.**

---

## Correction log

Findings revised after specialist domain review + an independent Codex pass, both
verified against the code. Kept transparent rather than silently edited — an
adversarial report that misdiagnoses is exactly what the team should catch.

- **#4 (trash resurrection)** — root cause corrected. Local reads are JSON-based
  (`repository.native.ts:159-162`), so the dropped `deleted_at` column does not
  resurrect rows on device. The real bug is the sync path: a trashed-before-remote-id
  `create` uploads active and the post-create reconcile (`bookmarks.tsx:1756-1765`)
  omits `deleted_at`. Fix moved from `replaceBookmark` to the reconcile/create path.
- **#5 (anon→real carry-over)** — narrowed. `collection_id`/`is_archived` self-heal
  via the same reconcile; only **tags** are genuinely lost (pending tag ops not
  re-keyed on id swap). Severity HIGH→MEDIUM, fix scoped to tag re-keying.
