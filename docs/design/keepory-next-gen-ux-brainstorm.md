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

## Design hints (interpretive round)

_A third pass, one level deeper than observation: not "what patterns exist" or "what to build," but **what the patterns hint at** — the design DNA a keep-and-find app could inherit. Each hint reads: pattern → principle → provocation. Where all three lenses landed on the same idea independently, it's flagged as convergent._

**1. Kill the number that reads as debt.** _(convergent — all three lenses)_ Telegram's five-digit pills quantify neglect and call it information. The inversion is Keepory's signature: nothing on screen accrues *against* you. If a count exists, it's one you'd be proud of ("3 things you'd lost, re-found this week") or an un-triaged count that ticks *down* with a soft settle as you file — the feel of a shrinking pile, never a growing dread.

**2. Capture is sacred, made *physical*.** The chat bubble lands the instant you send; reconciliation is invisible. The release-to-save moment should land instantly and visibly — the row drops to position-zero with a settling haptic the moment your thumb lifts, fully decoupled from enrichment/sync. "Capture is sacred" becomes something *felt* on every save, which is what earns the next thousand.

**3. Retrieval memory is an asset, not exhaust.** Telegram treats Recent searches as disposable ("Clear All"). Backwards for a keep-app: a query you repeat is recurring intent. Search can stage the answer before the question (just-saved, just-opened, "saved near here"), and a search run three times can offer to become a named shelf — retrieval habits promoting themselves into structure the user never had to author.

**4. The app talks to you where you already are.** Telegram's error sits *in* the row; its confirmation card sits *in* the settings list — non-blocking, ignorable. Steal the mechanism, reject the nagging content: AI suggestions arrive as ambient, swipe-away in-stream cards (accept is a tap, ignore costs nothing), and a broken link keeps its row and gets *quieter* rather than growing a nag badge. Capture is never punished for enrichment failing.

**5. Containers should smell of their contents.** "Account — Number, Username, Bio" tells you what's inside before you tap. The provocation: a collection's subtitle is a generated (clearly-generated) content fingerprint — "mostly recipes · last added yesterday" — not a raw count.

**6. Visual recall is a right, not a luxury of good OG tags.** Every Telegram row has a monogram handle for the eye to grab. So: no save is ever a grey wall of title text — an honest domain-derived colored monogram renders optimistically from frame one, stable before enrichment returns.

**The productive tension — time.** UX's headline bet was *time as the primary recall axis*: memory is episodic ("the article I saved during that flight"), the app stamps time for free, enrichment can't corrupt it, so scrub-to-when would feel like *remembering* rather than filing. Grumpy's near-opposite: *don't default-sort by arrival* — you saved it because it matters later, so a recency list re-buries intent. The reconciliation is the insight: **time is a powerful retrieval *lens* (a scrub-to-find gesture), not the default list *order* (which should lead with intent — un-triaged / pinned / revisited).**

**The spine.** If one sentence ties the hints together: *a keep-and-find app should feel like a calm, single-player memory — you drop something in and it's instantly, physically yours; nothing ever accrues against you; and finding it later feels like remembering, not searching.* Every hint above is a facet of that sentence. These are directional, not committed scope.

## Stress-test — the top 3 bets, adversarially broken (then narrowed)

_Before getting attached, we ran the three highest-momentum hints through an inversion pass: try to break each. All three came back **wounded**, and the objections were good enough to change course. What survives is each bet narrowed to its honest core._

**Bet 1 — Kill the debt-number.** _Kill shot:_ a down-ticking un-triaged count is *still a debt number if it never reaches zero* — a fast-saver / slow-filer watches it climb (save 40, triage 6 → "calm" counter reads 34 and rising). And the one "proud" number ("3 re-found this week") reads "**0** re-found this week" for a diligent saver — inventing productivity guilt where there was none. _Hidden cost:_ "no count ever accrues" becomes a global veto on every future count (shelf totals, search results).
→ **Narrowed:** the debt-feeling comes from *any count that can't reach zero*. Our nav decision already fixes this — **Inbox = un-triaged only**, a queue designed to empty, so its count *can* hit zero (the actual "inbox zero" feeling). Keep that count; **drop the "re-found this week" vanity metric** (the fragile piece that manufactures guilt). _Open question:_ what does a fast-save/slow-file user see on day 30, and what's the honest "done" definition per item?

**Bet 2 — Capture made physical.** _Kill shot:_ position-zero-on-release only feels physical if the row *stays* at position-zero — but the thesis is "don't default-sort by arrival." Under any non-newest sort or active facet, the thumb lifts and the row lands offscreen or vanishes (doesn't match the shelf); the haptic fires where the eye isn't — a promise the layout can't keep. Enrichment reorders the row seconds later anyway, and a haptic felt 50×/day habituates into the badge-blindness we mock.
→ **Narrowed:** decouple reassurance from *position*. Confirm with a brief **settling highlight wherever the row belongs under the current sort**, plus the existing `CaptureToast`, and fire the haptic **only on a genuinely new capture** (duplicates already write nothing, bounding frequency). Reassurance you can always keep; a position-promise you can't. _Open question:_ does the haptic survive being felt 50× a day, or does it need a rarer trigger?

**Bet 3 — Time as a recall lens.** _Kill shot:_ `created_at` is *capture* time, not *experience* time — you read the article on the flight and saved it 3 days later from your laptop, so for the highest-value (deliberate, deferred, re-saved) items save-time ≠ memory-time exactly. Co-occurrence surfaces whatever you bulk-imported that afternoon (noise, not narrative). Episodic labels need save *density* the median user (≈2 saves/week) lacks → the rail is a featureless smear. Biggest build, thinnest validated need; the honest v1 collapses into one more facet chip.
→ **Demoted** from bet to **cheap gated experiment:** ship *only* the temporal search chips inside Search-as-a-tab, measure whether "that weekend" out-taps scrolling, and never build the rail/filmstrip speculatively. _Open question:_ what fraction of saves land in the same session as the memory being reached for — if it's low, there's nothing here but a fancy date filter.

**Net:** the spine holds, but the two cheap bets get sharper and the expensive one is parked behind a metric. **Drop-first if forced to two: Bet 3** — prototype it only after Search-as-a-tab proves people re-find at all.

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

## Bottom tabs — final shape (supersedes the sketch above)

_The ranked sketch above was an early draft (`Inbox · Search · Library · You`). Two rounds of team debate revised it. The rule that settles composition: a bottom tab is a **place you dwell** — a top-level job, not a filter of another tab, answering "where am I?" not "what am I filtering?" By that test Capture is an action (the FAB), Search is a query (a top-right icon), Settings is a top-right icon — so **"You" is dropped**. That leaves the three things you actually browse:_

**`Inbox · Library · Tags`** — with the **capture FAB** and **search + settings as the two top-right icons** (Variant B anchored rounded-top bar; `add`/`settings` stay modals presented over the tabs).

| Tab | Its one job | Contains | Must **not** contain | Badge |
|---|---|---|---|---|
| **Inbox** | Process what's new | Un-triaged items · per-collection pills · capture FAB · un-triaged count | Already-filed items (they've graduated to Library) | Neutral count that **ticks to zero** |
| **Library** | Find what you've kept | Collection shelves with content-fingerprint subtitles · "All items" · sort controls | Any triage queue / "unread" pressure — it **never empties** | None |
| **Tags** | Find by topic, across everything | Tag cloud/list with counts · tap a tag → its items library-wide | Collection structure · a filter-pill row (**it *is* the filter**) | None |

Load-bearing distinction: **Inbox is a queue that empties; Library is a shelf that never does.** A new save is in Inbox until triaged but *always* in Library. Same data, two jobs. Open fork: Tags stays a tab for v1 (cheap, a real axis, `browse/tags.tsx` already exists), but wire it to the retrieval-taps metric — demote to a Library `Collections | Tags` toggle if usage is low.

### Where AI-suggestion review lives

Not a tab, not a stack-buried screen — that's the blocking review *queue* the hints told us to reject. It's a **cross-cutting lens over the whole corpus** (a suggestion can land on an already-filed Library item via background/other-device enrichment, so it can't be pinned to Inbox), delivered in three layers:

1. **Default (ambient):** suggestions render as a **swipe-away chip row on the item wherever it lives** — Inbox card, Library card, Detail. Accept = tap, ignore = free. No navigation.
2. **Overflow:** the existing **"✨ N new" Inbox banner** → a transient **"✨ Suggested" filter** gathering every item with pending suggestions across the library into one focused list (built like the `/browse/tags` transient view — a lens, not a permanent tab).
3. **Discoverability:** a quiet **Settings row** ("Review AI suggestions · N") deep-links into the same filter.

`review.tsx`'s content (folder + tag recs, accept-all/dismiss-all) survives — it becomes *what the "✨ Suggested" filter renders*, entered as a lens rather than a destination. Requirement: the ✨ badge/banner counts must span **all** items, not just un-triaged ones (mostly already true via the "unseen suggestions" work in `AGENTS.md`).

## Do NOT copy

Unread alert badges · large tinted count pills · a social Posts feed · chat-grade forced density · scoped search *type* tabs · a re-introduced Archived section. Every one is scar tissue around Telegram's overwhelm problem — copy the look and you import the anxiety.

## The bold bet: **Capture Stream** — the inbox *is* a chat you talk to

Telegram's single most-used feature is people forwarding links to **Saved Messages** — i.e. bookmarking to themselves. That's Keepory's entire thesis, validated at mass scale. Push it further: replace the "add bookmark modal" with an always-present **compose bar** at the bottom of the Inbox. Paste a link / type a thought / drop an image — it appears **instantly as your bubble** (local-first, optimistic, nothing blocks — capture stays sacred). A few seconds later AI enrichment **streams back as a visually-distinct system reply**: title, suggested folder, tags, one-tap accept.

Why it fits Keepory specifically: it makes the **user-authored vs. generated split** *structural* — your bubble is what you typed, the reply is what the machine guessed, and they can never be confused because they're literally different speakers. It collapses our two hardest moments — *saving without friction* and *triaging without a chore* — into one conversational gesture no bookmark app has. High risk, high reward; worth a throwaway prototype before anything else on this list, because if it lands it reframes the whole app.

## Suggested first slice (if we act on any of this)

Ship the **`Inbox · Library · Tags` tab bar + persistent muted-count shelves** together (per "Bottom tabs — final shape" above) — mutually reinforcing, mostly reuse, low-risk. Search ships as a **top-right icon** on day one (not a later tab), scoped by the active facet with recent history. Prototype **Capture Stream** on a throwaway branch in parallel to learn whether it's the real direction before we invest in the incremental path.

---

_Files referenced: `apps/mobile/src/app/_layout.tsx` (stack → tabs), `apps/mobile/src/app/index.tsx` (`FacetChip` ~132, count wiring ~823–834, `Animated.FlatList` ~222–225, scoped search ~1080), `apps/mobile/src/domain/sort.ts`, `apps/mobile/src/domain/view-mode.ts`, `AGENTS.md` (Trash-replaces-archive; view/sort/AI-suggestion inventory)._
