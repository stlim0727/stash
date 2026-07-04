# Next-gen Keepory UX — brainstorm from the latest Telegram

_Brainstorm, 2026-07-04. Prompt: "let all team members look at the UX of the latest Telegram and brainstorm over next-generation Keepory UX." Inputs: a 20s Telegram (Android) screen recording + reviews from product-ux-designer, mobile-ui-engineer, and grumpy-smurf. This is a brainstorm, not a spec — nothing here is committed to a milestone yet._

## What the latest Telegram actually does (from the recording)

- **Bottom tab bar** — Chats / Contacts / Settings / Profile, with a live unread badge on the Chats icon. Telegram moved off the hamburger drawer.
- **Folder-chip filter row** — a horizontally-scrollable row under the search bar: `All 173 · Forex 60 · 안읽음(Unread) 276 · 개인적(Personal) 146 · 주식(Stocks)`, each with a live count. You scroll to a folder as a durable view, not a transient filter.
- **Scoped unified search** — tapping search reveals type sub-tabs `Chats · Channels · Apps · Posts · Media` plus a **Recent** list with **Clear All**.
- **Pinned Saved Messages + collapsible Archived Chats** at the top of the list.
- **Profile as a tab** — a `Set Photo · Edit Info · Settings` action-button row, then a personal **Posts / Archived Posts** feed with an "Add a post" FAB.
- **Very high list density** — 8–9 rows/screen, monogram + one truncated line + a large count pill; compose FAB bottom-right.

One thing the frames make unmissable: the list is a **firehose of spam** trading/forex/crypto channels with five-digit unread counts (`GOLDHUNTER PAUL 15610`, `Binance Killers 6822`). Much of Telegram's chrome — badges, counts, folders, archive — is *coping machinery for overwhelm*. That context matters for what we borrow.

## Where the team agreed

**Bottom tabs are the right structural move.** Keepory today has no tab bar; Review, Trash, Graph, Settings, and Report all hang off stack-pushes from the single Inbox screen (`apps/mobile/src/app/_layout.tsx`, the `router.push('/settings')`/`/report` calls in `index.tsx`). That buries the whole app behind one screen. A `(tabs)` group — **Inbox · Search · Library · You** — makes Keepory read as a *product* instead of a screen with buttons. Effort **M** (expo-router `Tabs`), with two known snags: `settings` (`transparentModal`) and `add` (`presentation:'modal'`) must stay modals presented *over* the tabs, and the Inbox hardware-back "peel" handler assumes the Inbox is the app root — a tab bar redefines "root," so that logic needs re-checking.

**The folder-chip row is already 80% built.** Our facet shelf (`FacetChip`, `index.tsx:132`; count wiring `~823–834`) is functionally Telegram's folder row — live counts, horizontal scroll, active state, edge-fade all wired. The gap is only styling and permanence: ours is *derived* and *disappears on search focus* (`index.tsx:952`); Telegram's is durable identity you return to. Turning it into pinned, persistent, count-bearing "shelves" is **S–M**, mostly reuse.

**A "You" tab is assembly, not a build.** Settings already renders library counts, version, sync status, and the account card. Wrapping that in a tab + a reused action-button row (Sync now → existing `syncNow`; Review → `/review`; Trash → `/trash`) is composition of surfaces we already have.

## Where the team fought — and how we're landing it

| Question | Bull case (UX) | Bear case (grumpy) | **Landing** |
|---|---|---|---|
| Unread badges on tabs/rows | ambient "how much is waiting" pull | manufactures the exact inbox-**debt** anxiety "inbox-first calm" exists to kill; a saved link isn't an unanswered message | **No alert badge.** At most a neutral, un-tinted count of *un-triaged* items (no collection, unreviewed) — never a red pill, never a per-row count. The only honest "unread"-ish signal we own is user-triage state, not messages. |
| Big count pills on chips | makes the library feel alive | copies chat's "276 things rotting in here" scoreboard energy | **Keep counts muted** — secondary text weight, no alert color. Chips can be persistent; counts stay quiet. |
| Scoped search **type tabs** | Links/Notes/Highlights/Collections as sub-tabs | we have **one** content type (bookmarks); five tabs is a choice-tax for zero reach, and search is already facet-scoped (`searchPlaceholderScoped`, `index.tsx:1080`) | **Search becomes a first-class *tab*, but not five type sub-tabs.** The win is a search *destination* with **recent-search history + Clear All** (small persisted store, same pattern as `pref.inbox.sort`) and results scoped by the existing facet — not a parallel filter dimension. |
| Telegram "Posts" feed on Profile | a personal "recently stashed" timeline | social publishing is scope creep off a cliff — invents an audience/moderation/public-RLS model we deliberately don't have (owner-scoped RLS) | **Kill the social feed.** The "You" tab may show a *private* recent-activity list; "share a link" stays the OS share sheet, not a feed. |
| Chat-grade density | more per screen | bookmarks are retrieved by **visual recall** — the preview image/favicon is the memory hook; density kills it | **Card stays the default.** We already ship card/compact/list layout modes; density is an option, never the identity. Don't demote thumbnails to squeeze row count. |
| Pinned + **Archived** top sections | quick access | we deliberately *retired* archive for Trash (`AGENTS.md`); an "Archived" shelf resurrects the archive/active/trash confusion we just paid down | **No Archived shelf.** Trash stays the single lifecycle exit, reachable from the Library/You tab. Pinning favourite *collections* is fine; a second lifecycle state is not. |

## Recommended next-gen moves (ranked)

1. **Bottom tab bar — `Inbox · Search · Library · You`. (M)** The cheapest structural win; every other move needs somewhere to live. Inbox may carry a *neutral* un-triaged count, never an alert badge. Keep `add`/`settings` as modals over the tabs; re-verify the back-peel handler against the new root.
2. **Persistent count-bearing "shelves" from the existing facet chips. (S–M)** Make the facet row durable (don't vanish on search focus), pin/reorder collections, always include an **Un-triaged** shelf. Counts muted, not alarming. ~1-file restyle of `FacetChip` gets the Telegram *look* with zero new state; permanence + pinning is the added work.
3. **Search as a first-class tab with recent history. (M)** A real destination — recent searches + Clear All, scoped by the active facet. Retrieval is the entire payoff of saving; making it a place (with sub-second local filtering) is what a returning user feels daily. No type sub-tabs.

Quick wins that are already ~80% wired: the **chip restyle** (reuses existing count/scroll infra), a **"You" tab wrapper** (reuses Settings surfaces), and **new sort/scope presets** (`SORT_PRESETS`/`ViewMode` are additive registries).

## Do NOT copy

Unread alert badges · large tinted count pills · a social Posts feed · chat-grade forced density · scoped search *type* tabs · a re-introduced Archived section. Every one is scar tissue around Telegram's overwhelm problem — copy the look and you import the anxiety.

## The bold bet: **Capture Stream** — the inbox *is* a chat you talk to

Telegram's single most-used feature is people forwarding links to **Saved Messages** — i.e. bookmarking to themselves. That's Keepory's entire thesis, validated at mass scale. Push it further: replace the "add bookmark modal" with an always-present **compose bar** at the bottom of the Inbox. Paste a link / type a thought / drop an image — it appears **instantly as your bubble** (local-first, optimistic, nothing blocks — capture stays sacred). A few seconds later AI enrichment **streams back as a visually-distinct system reply**: title, suggested folder, tags, one-tap accept.

Why it fits Keepory specifically: it makes the **user-authored vs. generated split** *structural* — your bubble is what you typed, the reply is what the machine guessed, and they can never be confused because they're literally different speakers. It collapses our two hardest moments — *saving without friction* and *triaging without a chore* — into one conversational gesture no bookmark app has. High risk, high reward; worth a throwaway prototype before anything else on this list, because if it lands it reframes the whole app.

## Suggested first slice (if we act on any of this)

Ship the **tab bar + persistent muted-count shelves** together (moves 1–2) — they're mutually reinforcing, mostly reuse, and low-risk. Hold **Search-as-a-tab** for a fast follow. Prototype **Capture Stream** on a throwaway branch in parallel to learn whether it's the real direction before we invest in the incremental path.

---

_Files referenced: `apps/mobile/src/app/_layout.tsx` (stack → tabs), `apps/mobile/src/app/index.tsx` (`FacetChip` ~132, count wiring ~823–834, `Animated.FlatList` ~222–225, scoped search ~1080), `apps/mobile/src/domain/sort.ts`, `apps/mobile/src/domain/view-mode.ts`, `AGENTS.md` (Trash-replaces-archive; view/sort/AI-suggestion inventory)._
