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

## Observed patterns catalog (team observation round)

_A separate, deliberately non-prescriptive pass: the team re-watched the recording just to name **what UX is actually there**, before deciding anything. Three lenses — IA/interaction, UI mechanics, and the honest "what it reveals" read. Frame numbers refer to the 20 extracted frames._

**Navigation & information architecture**
- **Two-tier nav, cleanly separated** — bottom bar = 4 *destinations* (Chats/Contacts/Settings/Profile, icon+label, active tinted blue); top row = *filters* over the current list. The app never lets "where you are" look like "what you're filtering." (1–20)
- **Folder/filter chip row** — scrollable pills `All 173 · Forex 60 · Unread 276 · Personal 146 · Stocks`, each with an inline count; active chip fills solid blue; re-scopes the list in place. (1–6)
- **Pinned special rows at the top** — Archived Chats (own `76` count) and Saved Messages sit above real chats using the same row grammar. (1)
- **Entity-type subtitles teach identity** — rows label *what a thing is*: "private channel", "public channel", "bot", "last seen 3:10 PM". (17–20)

**Count/badge system**
- **Count pills do double duty** — unread indicator on rows, size indicator on folder chips; blue = active-unread, muted grey = muted-but-unread (with a crossed-speaker glyph). (1–6)
- **A dedicated "Unread 276" folder** — a first-class filter just for "stuff I haven't dealt with."

**Search model**
- **Scoped unified search** — field + second-level sub-tabs `Chats · Channels · Apps · Posts · Media` to switch query scope by content type. (17–20)
- **Recent + "Clear All"** — prior targets listed with type captions before you type; one action wipes them. (18–20)
- **Two entry points** — app-bar magnifier *and* a persistent search field atop the list, both morphing into the same search surface. (1–6)

**List & density mechanics**
- **Consistent row anatomy** — avatar/monogram · bold title (inline verified/scam/emoji badges) · one-line preview (sender bolded, media glyph) · right-aligned timestamp · unread pill. (1–20)
- **High density** — 8–9 full rows/screen, edge-to-edge, content bleeding under header and nav.
- **Compose FAB** — blue circular "+", floating bottom-right, distinct from tab nav. (1–3)
- **Flat, high-radius visual system** — fully-rounded chips/pills/avatars, ~12px rounded fields, near-black bg with one accent blue; separation by color/spacing, not shadow.

**Identity surfaces**
- **Profile action-button trio** — `Set Photo · Edit Info · Settings` as three equal tiles, then labeled info rows. (10)
- **Profile "Posts / Archived Posts"** — a lightweight publish-to-profile feed with empty state + "Add a post". (10)
- **Settings rows with descriptive subtitles** — "Account — Number, Username, Bio" previews what's inside before you tap. (8–9)

**Microcopy, states & confirmations**
- **Inline confirmation card** — "Is +82… still your number?" with reassuring copy, "Learn more", and **No / 👍 Yes** — non-blocking, dismissible, lives *inside* the settings list. (8–9)
- **Inline error state** — "This channel can't be displayed…" shown in the preview slot, not a modal. (1–3)
- **Real Android status bar / safe area** retained throughout; top inset respected, list runs to the gesture pill.

**The honest read — what these patterns _reveal_**
Nearly every polished pattern above is coping machinery for a content problem, and that's the load-bearing lesson:
- The list is almost entirely **monetized channel spam** (one channel is literally named *"Alphabet Forex is a scammer"*); folders, the Unread tab, archive, and count pills exist to *survive the firehose*, not to organize a life.
- **Five-digit pills are dread, not signal** — nobody clears 15,610; past ~99 a badge trains you to ignore all badges, breaking the one that matters.
- The **"Unread" folder is a debt-tracker** — a healthy app doesn't need a permanent tab for its own backlog.
- **"This channel can't be displayed"** still carries an `834` badge — a dead row you can't read *or* dismiss, nagging anyway. (1–3)
- The **verification card** is retention instrumentation colonizing a utility screen; the 👍 on "Yes" is a nudge, not clarity. (8–9)
- **"Posts"** is a social feed most users never fill — its "Add a post" CTA overlaps its own empty-state text. (10)
- **Two "profile" doors** (Profile tab *and* Settings tab, same avatar/@handle) — visible org-chart seams in the IA.
- Content **bleeds under the bottom bar** (급등일보 peeking beneath the nav) — a floating bar eating the last row instead of resting on a safe inset. (1, 3, 5)

**The takeaway that shapes the rest of this doc:** the video is a masterclass in *patterns* and a cautionary tale in *application* at once. The structural grammar (two-tier nav, scoped search, chip filters, inline states, descriptive subtitles) is worth learning from; the loud, anxiety-driven surface (big counts, a debt-tab, a feed, chat density, the inset-eating bar) is scar tissue around overwhelm we don't have. **Borrow the grammar, reject the anxiety.**

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
