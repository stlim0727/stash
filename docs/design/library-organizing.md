# Library-level AI organizing ("Tidy Up") — design + phased plan

Status: **Phase 0 shipped; Phases 1–2 specced, deferred (need demand signal)**
Owner: Product & UX + Backend/Security + Domain/Sync (cross-cutting)
Surface (Phase 0): `supabase/functions/ai-enrich/` (the enrichment prompt)
Surface (Phases 1–2, deferred): a new `/tidy` screen, a new `ai-organize` edge
function, an owner-scoped tag-merge RPC
Related: per-item enrichment (`ai-enrich`), the Review screen
(`apps/mobile/src/app/review.tsx`), tag storage
(`domain/pending-tags.ts`, `sync/pull-bookmarks.ts`), the data model
(`docs/architecture/data-model.md`)

---

## 1. What this is (and isn't)

A category of AI feature that operates on the **whole library**, not one item —
a predefined menu of "organize my saved stuff" actions (not a free-form chat).
The motivating example was **"merge similar tags."**

The brainstorm converged on a "Tidy Up" surface: a growing menu of organizing
functions, each following the app's existing **propose → review → apply → undo**
trust model, scaled from per-item to library-wide. **User-authored fields stay
sacred**; AI only ever proposes, and only ever fills or consolidates generated
data unless the user explicitly approves otherwise.

---

## 2. What the real data said (this drove every decision)

We inspected the live database before committing. Findings (users with ≥10
active bookmarks — there are **only 3**):

| User | Active bm | Tag vocab | Orphan tags (≤1 use) | Untitled | Exact dup URLs |
| ---- | --------- | --------- | -------------------- | -------- | -------------- |
| A (heaviest) | 138 | 296 | 88% | 1 | 0 |
| B | 20 | 74 | 95% | — | — |
| C | 10 | 27 | 81% | — | — |

The mess is **tags**, and it's systemic across every real library:

- **Titles are fine** (1 untitled; metadata pipeline healthy) → "fix titles" is a
  non-feature.
- **Duplicates are already prevented** at capture (0 exact-dup URL groups; the
  `url_hash` unique index works) → "find duplicates" is a non-feature.
- **Collections are healthy** (heaviest user already has 18) → "suggest new
  collections" would just invent overlap.
- **Tags are catastrophically fragmented**: 296 tags over 138 bookmarks, 88% used
  once. One concept, *swimming*, is smeared across ~19 tags in mixed
  Korean/English (`수영` · `swimming` · `aquatics` · `수영 강습` · `수영 팁` ·
  `수영기술` · `접영` · `backstroke` · …). 268 of 296 tags are `source: 'ai'`;
  only 28 are user-authored.

The fragmentation is **not** many distinct topics — it's a handful of concepts
each exploded into a dozen near-duplicate labels. It is highly mergeable.

**Root cause:** `ai-enrich` invents fresh tags per bookmark. It already passes
the user's *collections* into the prompt to steer reuse, but never passed their
*tags* — so the model had no view of the existing vocabulary and coined a new
near-synonym every time.

---

## 3. The phased decision

An adversarial review made the call explicit: building a permanent, maintained
"Tidy Up" platform (new edge function + rate-limit ledger + transactional merge
RPC + inverse-undo RPC + two screens) to clean up a mess **3 users** have is
premature (CLAUDE.md §2, simplicity-first). The bulk of the ROI is stopping the
bleeding, which is one prompt change and helps **every** user and **every**
future bookmark.

So:

- **Phase 0 — root-cause fix (SHIPPED).** Make `ai-enrich` reuse the existing
  vocabulary. Stops fragmentation going forward. §4.
- **Phase 1 — clean the existing libraries (one-off, when wanted).** A guided
  one-off script (à la `scripts/dedupe-bookmarks.mjs`), not a product surface —
  three libraries is a one-time job. §5.
- **Phase 2 — build the "Tidy Up / Consolidate tags" surface (DEFERRED).** Only
  if merge demand recurs *after* Phase 0, with real signal (more users, growing
  libraries). The spec is captured in §6 so the work isn't lost. §6.

---

## 4. Phase 0 — the `ai-enrich` reuse fix (shipped)

Symmetric to the existing collection-reuse behavior:

- `provider.ts` — `EnrichmentInput` gains `existing_tags?: string[]`.
- `gemini-provider.ts` — the tag list rides in the prompt (`Existing tags (reuse
  when one fits): …`), and the system instruction tells the model: *if an
  existing tag fits, reuse its exact name verbatim rather than coin a
  near-duplicate; only invent a new tag when none fits.* Reused tags are copied
  verbatim (not translated), mirroring collection-name handling.
- `index.ts` — loads the owner's tags with usage counts
  (`/tags?...&select=name,bookmark_tags(count)`), sorts most-used first (in the
  function, so it's independent of PostgREST aggregate-ordering support), and
  caps at `MAX_EXISTING_TAGS = 80`. The cap bounds per-capture prompt cost; the
  most-used tags (the canonical ones worth reusing) lead the list.

Loaded on **both** the app path and the server-trigger path (reuse matters most
at capture), scoped to the bookmark's owner exactly like collections.

**Cost note:** this adds ~80 short strings to every per-capture enrich prompt
(the one op that runs per bookmark, so prompt bloat actually matters). The 80-cap
is the bloat/benefit knee; Gemini context caching is the pressure valve if enrich
volume climbs (the tag list is stable across a burst of captures) — a follow-up,
not built now.

**Watch-item:** don't let reuse tip into *over*-reuse (jamming a bookmark under a
loosely-related existing tag) — the inverse failure of the spray problem. Worth
eyeballing on real output.

Tests: `gemini-provider.test.ts` asserts the vocabulary rides in the prompt
(most-used first) and that the reuse instruction is present, and that the line is
omitted when the user has no tags yet.

---

## 5. Phase 1 — clean existing libraries (one-off, deferred)

A read-then-propose script that clusters an owner's tag vocabulary and merges on
confirmation — same shape as `scripts/dedupe-bookmarks.mjs`. Run per user against
the live project. Not a product surface. Do when someone wants the existing three
libraries cleaned; not required for Phase 0 to deliver value.

---

## 6. Phase 2 — "Tidy Up / Consolidate tags" surface (specced, deferred)

The full design, should demand justify it. **Do not build without the fixes in
§6.4** — the first-pass design had real holes.

### 6.1 Product / UX

- **`/tidy`** — its own screen (Settings only *links*; Settings is config, not
  workflow), a menu of function cards each with a live count hook ("Consolidate
  tags · ~47 groups"). Built to grow: future functions are one array entry +
  their own count. v1 ships exactly one real card + an honest "more coming"
  footnote (no fake "coming soon" cards).
- **Consolidate-tags review** — a scroll of merge-group cards, each showing the
  canonical (inline-editable; a `source:'user'` member is the default survivor
  and wears the "yours" chip + `YOUR TAG · KEPT` caption), the members being
  absorbed (removable dashed `✨` chips), an impact line ("19 tags → 1 · affects
  12 bookmarks"), and per-group merge/dismiss. Sorted by impact; a sticky "Merge
  N groups" footer; one bundled Undo toast.
- **Naming (KO/EN):** surface *Tidy Up* / **정리**; function *Consolidate tags* /
  **태그 합치기**; Undo copy matches existing `되돌리기`.
- **States:** first-run explainer ("nothing changes until you approve"),
  all-clean reward, small-library gate (present-but-dimmed), post-apply
  confirmation.

### 6.2 AI / backend (`ai-organize` edge function)

- New function cloned from `ai-enrich`'s seam (swappable provider, structured
  output, `isUuid` guards, `verify_jwt=false`), **app-path/JWT only — no
  service-role, no secret header** (no trigger fires this).
- Action-dispatched (`action: 'tag_merge'`) so future ops slot in. Input is the
  **tag vocabulary only** (id/name/usage_count/source — no bookmark content);
  output is merge groups `{canonical_name, canonical_tag_id, member_tag_ids[],
  confidence}`, bounded (≤40 groups, ≤25 members), every id validated against the
  loaded vocab and used in at most one group.
- **Model:** `gemini-2.5-flash` (not Flash-Lite) at temp 0.1 — cross-lingual
  synonymy + hierarchy is harder than per-item tagging, and Flash-Lite degrades
  on Korean nuance (접영 butterfly vs 배영 backstroke are *distinct*).
- **Cost/abuse:** vocab-only, ~constant cost regardless of library size. A
  separate, stricter per-operation ledger (`request_ai_organize_slot`; signed-in
  ~3/hr, 10/day; **anonymous zero**). Gate LLM merge to signed-in users. Only tag
  names leave the device; log op metadata + token counts, never content (and do
  **not** echo the prompt in error logs).

### 6.3 Domain / sync (the merge mechanism)

- Tags are a **read-only client snapshot** today with **no delete/rename/merge
  primitive** — that gap is the core build.
- **Apply = a single owner-scoped Postgres RPC** `merge_tags(jsonb)` that
  transactionally repoints `bookmark_tags` (pre-aggregated by `bookmark_id` to
  avoid the `ON CONFLICT` "affect a row twice" error) then deletes loser tag
  rows, and returns an undo journal. Client re-pulls (tags pull wholesale, so the
  merge lands with zero new sync machinery). Chosen over client fan-out because
  the delete cascades links — a torn intermediate state is data loss, so it must
  be one transaction.
- **Online-only** apply is acceptable: *capture is sacred; organizing is not.*
- **Undo** = inverse RPC restoring loser rows by original id, tolerant of
  since-deleted bookmarks; **session-scoped single-step** (full time-travel out of
  scope).

### 6.4 Blockers to fix before any Phase 2 build

Adjudicated from the adversarial review:

1. **`SECURITY INVOKER`, not `DEFINER`.** The user owns every row; existing
   owner-scoped RLS already enforces it. DEFINER bypasses RLS and forces
   hand-written `user_id = auth.uid()` on every statement (one miss = cross-user
   tag deletion) plus `search_path` pinning. INVOKER gets it free.
2. **Blocking apply, not optimistic.** Online-only + optimistic + no queue is
   self-contradictory: on RPC failure the next wholesale tag-pull *resurrects* the
   merged tags. An unqueued op must `await` and update state only on success.
3. **Serialize the tag queue, don't slug-remap it.** Pending per-bookmark tag
   ops carry `tag_name` (not id); `ensureTag` recreates a deleted tag by slug, so
   a queued/in-flight/other-device op resurrects a just-merged loser (and a
   remapped *remove*-op strips the winner link). Drain/settle `syncTagOps` and
   gate on no pending op targeting an affected slug **before** the RPC.
4. **Undo must journal per-link tuples** `(bookmark_id, tag_id, source,
   confidence)`, tolerate since-deleted bookmarks row-by-row, and restore the
   survivor's upgraded `source` — otherwise "Undo" corrupts link state (and can
   itself violate the sacred-field rule by leaving a formerly-user tag as `ai`).
5. **Default every merge group *unchecked*.** Pre-checking `confidence ≥ 0.85` +
   sort-by-impact + one-tap "Merge all" makes destruction the default, and the
   confidence is the model's uncalibrated self-report on *names alone* (no
   bookmark context) — exactly where over-merge risk is highest.

Additional guard: if a group's canonical is an *invented* name while any member
is `source:'user'`, the survivor must instead be that existing user tag (id
reused, `source` resolves to `user`) — never a fresh `ai` row owning
user-authored links.

---

## 7. Open decisions (user's call)

- Whether/when to run Phase 1 on the existing three libraries.
- Whether Phase 2 ever builds, and if so whether "Tidy Up" is free or a paid /
  signed-in tier (it's the strongest paid-tier candidate — highest compute,
  clearest big-library value; see `docs/strategy/monetization.md`).
- The nudge/gate thresholds (proposed ~12 groups & ~60 tags to nudge; <40 tags to
  gate) — tune against instrumented prod.
