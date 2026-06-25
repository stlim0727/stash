# Welcome to Stash

> **Team goal:** establish a **monetization strategy** for Stash. New work should
> ladder up to that — pricing, paid tiers, conversion, cost-to-serve. The CI and
> release work in the stats below is what keeps the app shippable while the team
> figures out the business model. See `docs/strategy/monetization.md` for the
> first-cut strategy brief.

## How We Use Claude

Based on Claude's usage over the last 30 days:

Work Type Breakdown:
  Build Feature  ████████████████░░░░  80%
  Debug Fix      ████░░░░░░░░░░░░░░░░░  20%

Top Skills & Commands:
  _No slash commands recorded in this window_

Top MCP Servers:
  github  ████████████████████  194 calls

## Your Setup Checklist

### Codebases
- [ ] stash — https://github.com/stlim0727/stash

### MCP Servers to Activate
- [ ] github — drives all GitHub work (dispatch CI/APK builds, open/merge PRs, read Actions run logs, manage releases). Get access by configuring the GitHub MCP server with a token that has repo + actions scope for `stlim0727/stash`.

### Skills to Know About
- _No slash commands recorded in this window — see Team Tips for how the team works._

## Team Tips

- **The north star right now is monetization.** When you pick up work, ask how it
  serves the strategy — pricing/tiers, paid-feature candidates, conversion,
  cost-to-serve (the AI enrichment + Supabase backend are the main variable
  costs). Read `README.md` (product direction), `AGENTS.md` (current state), and
  `docs/strategy/monetization.md` (the strategy brief) first.
- **Releases are tag-driven** via the `android-apk.yml` workflow: a blank or
  hyphenated dispatch (e.g. `v0.2.2-rc1`) refreshes the rolling `dev` prerelease
  for testing; a clean `vX.Y.Z` cuts a stable release. Every build auto-publishes
  a GitHub Release **and** distributes to testers via Firebase App Distribution.
- **Debug diagnosis-first.** For CI/auth failures, add a small leak-safe probe to
  pinpoint the cause *before* guessing at fixes — it beats churning builds on a
  hunch (that's how we nailed the Firebase auth bug).
- **Let Claude babysit your PR.** After you open one, Claude can watch it —
  auto-addressing Codex review comments and re-kicking CI until it's green.

## Get Started

Your first task: **help shape Stash's monetization strategy.** A good Claude
warm-up that doubles as real work — start from `docs/strategy/monetization.md`:

- Pressure-test the proposed Free/Pro tiers and the "what stays free forever" lines.
- Help instrument real AI-usage data (enrichments per user / month) so the free
  AI quota is grounded, not guessed.
- Or pick up a readiness-gate item (image sync, API hardening, entitlement table).

_(No ticket link yet — ask your teammate where this work should live.)_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
