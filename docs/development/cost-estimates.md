# Cost estimates

A back-of-envelope guide to what running Stash costs as usage grows, and which
knobs control the bill. Numbers are **June 2026** list prices and will drift —
treat them as orders of magnitude, not quotes. Two services scale with usage
(**Supabase** and **Gemini**); everything else is a small fixed cost.

> Re-check the live prices before relying on these: Gemini
> (<https://ai.google.dev/gemini-api/docs/pricing>), Supabase
> (<https://supabase.com/pricing>), GitHub Actions
> (<https://docs.github.com/en/actions/concepts/billing-and-usage>).

## The two usage-based costs

### Gemini (AI enrichment)

`ai-enrich` makes **one** Gemini call per bookmark (on capture, and on a manual
"Refresh AI suggestions"). The default model is **`gemini-2.5-flash-lite`**
(see `supabase/functions/ai-enrich/gemini-provider.ts`; overridable via the
`GEMINI_MODEL` secret).

- Pricing: **$0.10 / 1M input tokens, $0.40 / 1M output tokens**.
- Per enrichment: ~700 input + ~250 output tokens ⇒ **~$0.0002**; a heavy call
  (more context, longer output) ~**$0.0005**.
- **Free tier**: 1,000 requests/day, 15 req/min, 250k tokens/min — **per
  project**, resets at Pacific midnight (~07:00 UTC). Above that, calls degrade
  to the deterministic heuristics with `degraded_reason = rate_limited` until
  reset (or until billing is enabled).

**The app caps spend.** The per-user limiter
(`request_ai_enrichment_slot`, `supabase/migrations/…_ai_enrichment_rate_limit.sql`)
allows **200 enrichments/day per signed-in user** (50/day anonymous). So the
absolute ceiling is `users × 200 × $0.0005/day` — no runaway bill is possible.

### Supabase (backend)

Practical floor is **Pro at $25/mo** (the Free tier pauses after a week of
inactivity — fine for dev, not production). Pro includes 100k MAU, 8 GB
database, 250 GB egress, 2M edge-function invocations. Overages: $0.00325/MAU,
$0.125/GB disk, $0.09/GB egress.

What drives it here:
- **MAU** — Stash is anonymous-first, so **installs ≈ MAU**. 100k included
  covers most growth; past that you pay per active user.
- **Edge invocations** — one per enrichment; 2M/mo included is generous.
- **Database / egress** — bookmarks are tiny text rows and sync is local-first
  incremental, so both stay modest until ~100k users.

## Scenarios (per month)

Assumes Gemini flash-lite; "realistic" ≈ 30 enrichments/user/mo, "heavy" ≈ 150.

| Users | Supabase | Gemini (realistic) | Gemini (heavy) | Total (realistic–heavy) |
| ---: | --- | --- | --- | --- |
| 100 | $25 | ~$0.6 | ~$5 | **~$25–30** |
| 1,000 | $25 | ~$6 | ~$45 | **~$30–70** |
| 10,000 | ~$25–40 | ~$60 | ~$450 | **~$85–500** |
| 100,000 | ~$200–400 | ~$600 | ~$4,500 | **~$800–5,000** |

The per-user app cap means even a pathological 1,000-user month can't exceed
~$3,000 of Gemini spend; realistic usage is one to two orders of magnitude
lower.

## Fixed / non-usage costs

| Item | Cost | Notes |
| --- | --- | --- |
| Apple Developer Program | $99/yr | Required to ship on the iOS App Store. |
| Google Play registration | $25 once | Required to ship on Play. |
| Sentry | Free → $26/mo+ | Already wired; free tier (5k errors/mo) covers early. |
| EAS Build (Expo) | Free → $19/mo+ | Optional — the CircleCI `android_apk` job builds an APK without EAS. |
| Firebase App Distribution | **Free** | Tester APK delivery; no per-build/per-tester charge (Spark plan). |
| Expo push notifications | Free | — |

## GitHub (and the private-repo switch)

> **CI moved to CircleCI.** After the GitHub Actions quota below was exhausted,
> all CI/build workflows were ported to CircleCI (`.circleci/config.yml`; see
> `ci-circleci.md`). CircleCI has its own free-tier credit budget; the figures
> below are kept for historical context on the Actions setup.

The repo itself is **free** (unlimited private repos on the Free plan). The one
thing that changes when private is **GitHub Actions**:

| | Public | Private (Free) | Private (Pro $4/mo) |
| --- | --- | --- | --- |
| Actions minutes/mo | unlimited | **2,000** | 3,000 |
| Artifact/package storage | generous | **500 MB** | 2 GB |
| Overage (Linux) | — | $0.008/min | $0.008/min |

All current workflows run on **Linux (1× multiplier)**, so realistic usage
(CI per PR + occasional Android builds) fits inside 2,000 min/mo; overage is
cheap. Watch out for:

- **Artifact storage** — APKs are ~80 MB; this repo now keeps the APK artifact
  for **14 days** (`android-apk.yml`) so it doesn't fill the 500 MB quota.
- **macOS runners are 10×** — building iOS on GitHub (vs EAS) burns the quota
  fast. Currently none are used.
- **Branch protection / required CI checks** on a *private* repo need
  **GitHub Pro ($4/mo)**; on public it's free.

### What going private does *not* affect

- **Firebase App Distribution** — testers install via the App Tester app, not
  GitHub, so distribution is unaffected and stays free. (The CI upload step in
  the `android_apk` job works the same; it just needs the `FIREBASE_APP_ID` and
  `FIREBASE_SERVICE_ACCOUNT` env vars — see `releasing.md`.)
- **Supabase GitHub integration**, **Claude Code**, and other authorized
  integrations keep working on a private repo.
- ⚠️ **GitHub Release / artifact download links become private** — if you shared
  an APK that way, move distribution to Firebase App Distribution or the stores.

## Cost-control levers

1. **Lower the per-user daily cap** — `v_day_limit` in the rate-limit migration
   (default 200) sets the hard ceiling on Gemini spend; halving it halves the
   max.
2. **Pin thinking off** — add `thinkingConfig: { thinkingBudget: 0 }` to the
   Gemini `generationConfig` to keep output tokens (the pricier side) minimal.
3. **Budget alerts** — set a monthly budget alert in Google Cloud (Gemini) and
   a spend cap in Supabase to catch surprises early.
4. **Keep artifact retention short** and avoid macOS GitHub runners.
