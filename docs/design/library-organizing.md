# Library-level AI organizing ("Tidy Up") — design + phased plan

Status: **Phase 0 shipped (PR #395, merged); Phase 1 run for user A (totohero, 296→232 tags); Phase 2 specced + productization direction set (§8), build deferred**
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

## 5. Phase 1 — clean existing libraries (one-off)

**Status: run for user A (totohero) — 296 tags → 232.** 64 AI-generated
near-duplicates merged into 18 canonical groups (수영 ← swimming/aquatics/수영 강습/…,
요리 ← cooking/요리법/…, shorts ← youtube short/유튜브 쇼츠/…, …); **0 user tags
deleted** (a `source:'user'` tag was always the surviving canonical); 353 → 323
links after collision dedup. Applied via one owner-scoped SQL transaction, with
pre-merge snapshots kept in `tidy_backup_totohero_tags` /
`tidy_backup_totohero_bookmark_tags` for rollback.

**Who did the clustering:** a **frontier model reasoning directly over the
vocabulary** (operator + Claude), **not** the registered Gemini — `ai-enrich`'s
Flash-Lite only does per-item tagging, and the `ai-organize` function does not
exist yet. So this run's quality is the *target* the shipped feature must match,
not proof that it will (§8.4).

Remaining: users B and C not yet cleaned — same approach when wanted. This stays
a one-off script/operation, not a product surface; the product version is §6/§8.

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
- **Model:** *eval-selected — the best model that clears the precision bar, not
  the cheapest.* Organize is user-invoked, rare, and vocab-only, so cost is a few
  cents/op at any tier (the exact inverse of per-capture `ai-enrich`, where
  Flash-Lite's cheapness is load-bearing) — there's no economic reason to skimp.
  Decouple organize's model from enrich's (separate `ORGANIZE_MODEL`; the provider
  seam already allows a non-Gemini model). Prior: Flash-Lite fails near-neighbor
  precision (접영 butterfly vs 배영 backstroke), Flash is a coin-flip, frontier
  clears it — but **measure before committing** (§8.4). Temp 0.1. Canonical-survivor
  selection is **deterministic code, not a model job** (§6.4 additional guard).
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

- **Phase 1 cleanup:** user A (totohero) done (§5). Run B and C when wanted.
- **Model:** decided — use the best model that clears the precision bar (frontier
  is cheap at organize's frequency); confirm the exact model via the eval (§8.4).
  Not Flash-Lite.
- **Free vs paid:** team recommendation — the first spring-clean is **free** (the
  "wow, my library is clean" onboarding moment); gate re-runs and the filler-tag
  deletion tool. Final call is yours (`docs/strategy/monetization.md`).
- **Trigger:** a per-user fragmentation-index score (§8.5) — thresholds to tune on
  instrumented prod.
- **One spec conflict to adjudicate:** Band-1 pre-check (§8.2) vs §6.4 #5's
  "default everything unchecked" rule — grumpy to settle.

---

## 8. Productization direction — from the live Phase 1 run + team onboarding

Running Phase 1 live (§5) as a dry-run of the Phase 2 product surfaced concrete
answers to the two hard questions (how do the operator's ad-hoc judgment
questions become a normal-user UX, and does a shippable model match the demo).

### 8.1 The judgment calls become 3 generic controls, not questions

The 4 ad-hoc questions the operator was asked (수영 세부 → 수영? AI 하위 → AI?
요리법 → 요리 vs 레시피? 유튜브 → shorts?) were all the same shape: *should
sub-concept X roll up into parent Y (or a different parent / stay separate)?* A
shipped feature never asks a sentence. Three controls resolve every such case as a
tap on a preview that changes nothing until committed:

- **Promote-to-canonical** (tap a member chip → it becomes the survivor) — resolves
  "which parent wins" (요리 vs 레시피).
- **Eject member** (× a chip → back to standalone) — resolves "this doesn't belong /
  keep separate" (접영 out of a swimming lump).
- **Keep-separate** (dismiss the card) — resolves "don't merge these at all".

### 8.2 Risk-graded bands, not a confidence score

Sectioned review by *relationship type*, not by the model's (uncalibrated)
confidence number:

- **Band 1 "Same tag, different spelling"** — deterministic string-equivalence
  (casefold / whitespace / accent / obvious translation-pairs a normalizer can
  *prove*). **Pre-checked.** _(Open: does pre-checking provable string-dupes
  violate §6.4 #5's default-unchecked rule? The distinction — provable vs
  model-asserted — is defensible; grumpy to adjudicate.)_
- **Band 2 "Same meaning?"** — model-asserted synonymy/translation
  (swimming/aquatics/수영). Shown, **not** pre-checked, one-tap accept (+ "Combine
  all in section").
- **Band 3 "Related topics"** — hierarchy roll-ups (the 4 questions). Collapsed
  "Advanced" drawer, default **OFF**. Opening it is opting into judgment; this is
  where over-merge risk lives, so off-by-default is what makes the tool *safe*.

### 8.3 Expectation-setting: "combine", never "clean"

296 → 232 must read as success, not a half-done job. Framing verb is **combine
duplicate spellings**; the ~150 distinct topics are *intact curation*, never
touched. The ~40 generic-filler AI tags (delicious, 일상, value-for-money) are a
**separate, deferred, deletion-framed flow** — never mixed into merge (mixing
"combine" and "delete" in one review destroys the mental model and the trust).

### 8.4 The model: best, not cheapest — and now measurable

Organize is rare + vocab-only, so a frontier model costs pennies/op — use it. The
gap between the demo (frontier) and a shipped Flash is entirely **merge precision
on near-neighbors** (접영≠배영, 김치찌개≠된장찌개). The live Phase 1 run is now a
**human-approved ground-truth eval set**: the 18 applied groups (must-merge) + the
deliberate non-merges (must-NOT-merge hard negatives). The eval harness
(`scripts/tag-merge-eval/`) scores candidate models on **pairwise merge-precision
(gate ≥ 0.95)** + **zero forbidden merges across N ≥ 5 runs** + restraint
(tags-left-unmerged). Precision ≫ recall. Caveat: **n=1, overfit risk** — validate
on users B/C before trusting any "model X passes" verdict.

### 8.5 The trigger: a fragmentation index (the "entropy" mechanic)

A per-user accumulating score that gates the feature. Define it as a
**fragmentation index**, *not* topic-entropy — raw Shannon entropy over the tag
distribution conflates healthy diversity (many legit distinct topics) with
fragmentation (many near-duplicate synonyms), and would wrongly flag a rich-but-
tidy library. Compute a cheap **local proxy, no LLM**: normalized-slug collisions +
token-overlap cluster count + reuse ratio (`vocab_size / total_taggings`). It
updates on each capture; crossing a threshold (a) fires one gentle, dismissible
nudge and (b) **unlocks a free Tidy Up run**. After a run the index drops → the
surface goes quiet (the all-clean reward). Post-Phase-0 the index rises slowly, so
nudges are rare by construction. One number unifies **nudge trigger + free-run
unlock + quiet-after reset**.

### 8.6 Safety recap (independent of model quality)

The **default-OFF review gate is the primary protection** — a bad group the user
never checks produces zero bad merges, so a model precision-miss is a
*review-is-a-chore* UX problem, not data loss. Undo (bundled toast → persisted
journal) is the seatbelt, not the brakes. Two correctness must-haves that hold
regardless of model: `merge_tags` is `SECURITY INVOKER` (contrast:
`request_ai_organize_slot` is correctly `DEFINER` on a deny-all ledger — do *not*
"consistency-fix" merge_tags to DEFINER), and the pending tag-queue must be
**drained before the RPC** (§6.4 #3) or a *correct* merge still corrupts via slug
resurrection.
