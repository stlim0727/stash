# Welcome to Test mania

## How We Use Claude

Based on Claude's usage over the last 30 days:

Work Type Breakdown:
  Build Feature  ████████████████████  100%

Top Skills & Commands:
  _No slash commands recorded in this window yet_

Top MCP Servers:
  Context7  ████████████████████  4 calls
  github    ████████████████████  4 calls

## Your Setup Checklist

### Codebases
- [ ] stash — https://github.com/stlim0727/stash

### MCP Servers to Activate
- [ ] Context7 — Pulls up-to-date library/framework/API docs on demand (used here to research the Firebase App Distribution REST API). Enable the Context7 MCP server in your Claude Code config; no special access needed.
- [ ] github — Drives GitHub from Claude: open/review PRs, read CI/Actions status, post comments, manage releases. Configure the GitHub MCP server with a token scoped to `stlim0727/stash` (repo + actions).

### Skills to Know About
- `/review-pr` — Triage and review a GitHub PR for Stash; checks for superseded changes first, then gives a merge/close/changes-needed verdict.
- `/code-review` — Review the current working diff for correctness bugs and cleanup opportunities; `--fix` applies findings.
- `/screenshot` — Render a real screenshot of a Stash screen via the Expo web export + headless Chromium (no emulator needed).
- `/versioning` — Determine the correct next version and optionally cut a release, from the repo's real git tags + app.json state.
- `/user-bookmark-summary` — Per-user bookmark status report from the live Supabase database.

## Team Tips

- **Brainstorm before sticking to legacy.** Don't default to the existing pattern
  just because it's there — think through the options first, then commit. The best
  approach often isn't the one already in the codebase.

## Get Started

Your first task: **do more testing and automate it.** Look for coverage gaps and
manual steps that should be CI-driven, then wire them up. The Firebase App Testing
Agent integration (`scripts/firebase-app-distribution-test.mjs` + the
`Run App Testing Agent` step in `android-apk.yml`) is a recent example of pushing
testing further into automation — a good model to build on.

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
