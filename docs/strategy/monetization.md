# Stash Monetization Strategy — One-Page Brief (First Cut)

**Date:** 2026-06-25
**Status:** First-cut strategy proposal. **All prices and quotas are illustrative, not commitments.**
**Prepared by:** Chief of Staff, with product-ux, backend-security, competitor research, and an adversarial (grumpy-smurf) pass.

**Strategic timing:** Pocket shut down in 2025 (read-only July, deleted Oct/Nov), vacating the category's largest install base. There is a real opening — but see "Readiness" below: we should *design* monetization now and *charge* only after the gaps close.

---

## 1. Competitor pricing teardown

| App | Free tier? | Monthly | Annual | What converts (gating pattern) |
|---|---|---|---|---|
| **Raindrop.io** (closest comp) | Yes, generous (unlimited saves) | ~$3 | ~$28–38 ⚠️ | Full-text search, permanent copies, **AI tags**, file uploads |
| **Pocket** *(dead 2025)* | Yes | $4.99 | ~$44.99 | Permanent archive, full-text search, no ads |
| **Instapaper** | Yes (5 highlights/mo) | $5.99 | $59.99 | Full-text search, permanent archive, unlimited notes, Kindle, TTS |
| **Matter** | Yes | $8 | $60 | HD AI text-to-speech, full-text search, highlights |
| **Readwise Reader** | No (30-day trial) | $12.99 | $119.88 | Whole product paid; power "highlights→review" tool |
| **GoodLinks** | Paid app | — | $4.99 *(optional)* | $9.99 once; buy-once-own-forever |
| **Pinboard** | No | — | $22 + $39 archive | Archive + full-text search = the upsell |

**Synthesis.** Raw save-count is almost never the gate — Raindrop, Pocket, Instapaper, Matter all give **unlimited free saves** and monetize *retrieval & permanence* (full-text search, permanent archive) and, increasingly, **AI**. Category band: **~$3–8/mo, ~$28–60/yr**, annual discount ~20–25%. **No competitor sells a public API as a paid SKU** — it's bundled into Pro where it exists. That's white space *and* an unproven willingness-to-pay. ⚠️ Raindrop's exact annual price is unverified (official pages blocked automated fetch; third parties split $28 vs $38).

---

## 2. Proposed tiers (Free / Pro; Teams deferred)

**Free — forever, a complete and trustworthy bookmark app (not a trial):** unlimited capture from any app (**sacred — never gated, never throttled**); unlimited bookmark count/storage; cloud sync of the user's own data across devices; collections, tags, search, tag cloud, all views; OpenGraph metadata (deterministic, non-billable); **full export (HTML/JSON/CSV) always free**; small/occasional import; and a **metered taste of AI enrichment** that degrades gracefully to the existing heuristic/`degraded` state when exhausted — capture and the saved card stay intact.

**Pro — *illustrative* ~$3.99/mo or $29.99/yr (~37% annual discount):** generous/high-quota AI enrichment; on-demand AI refresh; higher-quality Gemini model (Flash vs Flash-Lite); bulk import **with** enrichment. **The public REST API + API keys is roadmapped Pro value, NOT a launch feature — see the red flag in §4.** No lifetime tier (recurring AI COGS makes it a negative-margin annuity).

**What stays free forever, and why:** capture (core promise), unlimited storage (a cap is hostage-ware), **sync of one's own data** (gating it reframes the product as holding data hostage), local search/tags/collections (zero marginal cost), and **export** (gating it makes a data-custody app a roach motel). These are deliberate, opinionated lines.

---

## 3. Cost-to-serve view

- **Gemini enrichment = the dominant variable cost. It scales with *engagement*, not revenue** — auto-fires once per capture (client + DB trigger, deduped to one call) plus manual refreshes. Per call is tiny (order $0.0001–0.0003 on Flash-Lite); the danger is **volume × free/anonymous users**, and Flash (Pro quality) is a 2–5× multiplier.
- **Supabase = mostly plan-tier fixed** until scale; marginal cost is egress (multi-device pulls of large libraries) and inflated MAU from anonymous sessions. **Images (0.3.x) will be the next variable-cost driver — ship it *with* a tier cap.**
- **Where a generous free tier bleeds:** unlimited AI on an anonymous-first, auto-enrich-on-capture app. Containment = a **monthly enrichment quota** (the shipped limiter only has hour+day windows — a 50/day anon cap is ~1,500/mo, ~30–50× the proposed "taste"; **these must be reconciled**), Flash gated to Pro, manual refresh gated, and graceful fall-back to the zero-cost DummyProvider when exhausted.
- **The limiter is the right *instinct* but not "just a tweak":** it branches on `is_anonymous`, **not a plan** — there is **no entitlement table anywhere yet**. Tier-awareness needs a net-new server-authoritative entitlements table + billing webhook + a tier lookup inside the `SECURITY DEFINER` function. And it **fails open** (correct for protecting cost, **wrong for a paywall** — a lookup error would hand out free Flash) and **spends a slot before the model runs** (a Gemini outage burns free quota on heuristic junk → refund/support pain). Both must change before it gates money.

---

## 4. Open questions / risks (with recommendations)

**RED FLAGS the team must resolve before any launch (from the adversarial pass):**

1. **The public API is revoked and unhardened — do NOT list it as a launch Pro feature.** Migrations `20260625*_revoke_all_api_keys.sql` revoked every key and removed the management UI; `public-api/index.ts` runs on **service-role with hand-interpolated `user_id` (RLS bypassed), no per-key rate limit, CORS `*`**. It's a roadmap item gated on a hardening track (per-key limits, RLS defense-in-depth, CORS lock-down + `/security-review`), not vaporware to sell today.
2. **"Priority enrichment queue" doesn't exist** (enrichment is fire-and-forget) — drop it from the feature list or build it first.
3. **Anonymous abuse isn't fixed by "thinnest tier."** Per-`user_id` caps don't stop *minting unlimited free anonymous users* × 50/day, and the DB trigger auto-enriches inserted rows with no session. Real fix = **global/IP mint-rate limit + a hard project-wide Gemini budget breaker**, plus reserving generous AI for signed-in users (acknowledge this is the first soft signup-wall in a "no wall" product).
4. **IAP tax + unit economics.** Apple/Google take 30% (15% after year one / Small Business Program); $3.99 nets ~$2.79. A Pro user on unlimited Flash + unlimited storage + auto-enrich can plausibly cost more than that. **Net margin is unproven — model it before pricing.** Anti-steering rules limit funneling to cheaper Stripe/web billing.

**Decisions the user must make (escalations — schema/billing/product-direction):**

- **Price points & the free AI quota number** — instrument real enrichments-per-user-per-month *before* committing; ~30–50/mo is currently a guess that contradicts the shipped caps.
- **Is sync free?** Recommend **yes** (gating own-data sync contradicts "capture is sacred"). High-stakes; your call.
- **Billing rails:** App/Play IAP (mandatory for in-app digital subs) vs web/Stripe, and the entitlement table + webhook are a **schema + auth-flow change** — escalates by policy.
- **Lifetime pricing:** recommend **no** (recurring AI COGS).

**Readiness risk — recommend designing now, charging later.** Per AGENTS.md, on-device capture/share (M4/M8) is unverified on real hardware, **image bookmarks are local-only and never sync** (a "cloud sync across devices" customer silently loses shared screenshots), and recent prod data-integrity bugs (ai-enrich 400, text-note dupes) are fresh. Charging money turns every open gap into a refund and a 1-star review. **Gate billing on:**

- [ ] on-device capture/sync verified on real hardware
- [ ] image sync shipped (no longer local-only)
- [ ] real AI-usage instrumentation (enrichments/user/month)
- [ ] public API hardened (per-key limits, RLS defense-in-depth, CORS lock-down, `/security-review`)
- [ ] entitlement table + server-authoritative quotas that fail **closed** and meter **successes**
- [ ] global/project-wide Gemini budget breaker + anonymous mint-rate limit

---

## Bottom line

The market validates the shape: keep capture, storage, sync, search, and export free and sacred; monetize AI volume/quality and (later) the API. The thesis is sound; the work the plan under-counts is the *billing backbone* (entitlement table, server-authoritative quotas that fail *closed* and meter *successes*, a global abuse breaker, IAP math) and *product readiness*.

**Recommendation: adopt this as the target model, but treat it as a 0.3.x+ track behind the readiness gate above — do not flip on billing yet.**

---

### Appendix — key files referenced

- `supabase/migrations/20260620000000_ai_enrichment_rate_limit.sql`
- `supabase/functions/ai-enrich/index.ts`, `supabase/functions/ai-enrich/README.md`
- `supabase/functions/public-api/index.ts`
- `supabase/migrations/20260625003436_revoke_all_api_keys.sql`
- `apps/mobile/src/api/bookmarks.ts`
- `AGENTS.md`

> Process note: research/strategy only — no code or app changes were made. Pricing numbers and quotas are illustrative inputs to a decision, not settings applied anywhere.
