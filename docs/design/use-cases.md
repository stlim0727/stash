# Stash — Use Cases (Visual)

A visual map of what Stash does and how each flow works end to end. The
authoritative, testable behavior lives in the
[UX spec](ux-spec.md); this page renders the same use cases as diagrams so the
system can be understood at a glance. Section references (e.g. _UX §1.2_) point
back to the spec.

> All diagrams are [Mermaid](https://mermaid.js.org/) and render inline on
> GitHub. Status legend: ✅ implemented & verified · 🔶 implemented, awaiting
> on-device verification.

---

## 1. System context — actors & use cases

Who interacts with Stash, and the capabilities each one drives.

```mermaid
flowchart LR
    user(("👤 User"))
    sheet(("📲 OS Share Sheet"))

    subgraph Stash["Stash mobile app"]
        uc_share["Save from another app"]
        uc_add["Add bookmark manually"]
        uc_browse["Browse / search / filter Inbox"]
        uc_detail["View & edit bookmark"]
        uc_org["Tag & file into collections"]
        uc_arch["Archive / delete"]
        uc_ai["Review AI suggestions"]
        uc_report["Report a problem"]
        uc_account["Manage account & sync"]
    end

    subgraph Cloud["Supabase backend"]
        db[("Postgres + RLS")]
        fn_ai["ai-enrich<br/>edge function"]
        fn_bridge["feedback-bridge<br/>edge function"]
    end

    sentry(("🛰️ Sentry"))

    user --> uc_add & uc_browse & uc_detail & uc_org & uc_arch & uc_ai & uc_report & uc_account
    user --> sheet --> uc_share

    uc_share & uc_add --> db
    uc_org & uc_arch & uc_account --> db
    uc_ai --> fn_ai --> db
    uc_report --> db --> fn_bridge --> sentry
    Stash -. "unhandled crashes" .-> sentry
```

---

## 2. Capture

The first product principle is speed: **capture now, organize later.** Both
capture paths persist locally first and never block on the network.

### 2.1 Manual add — _UX §1.1_

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant Add as Add Bookmark modal
    participant Store as Local store (SQLite)
    participant Inbox

    U->>Add: type / paste URL (+ optional note)
    Note over Add: scheme-less input normalized<br/>raindrop.io → https://raindrop.io/
    alt invalid URL
        Add-->>U: inline error, form kept (clears on next keystroke)
    else valid
        Add->>Store: upsert bookmark (sync pending · metadata pending)
        Note over Store: existing URL reuses the row<br/>(no duplicate, last_saved_at updated)
        Add->>Inbox: return immediately — bookmark already visible
        Store--)Store: background sync + enrichment (§4, §5)
    end
```

### 2.2 Share intake — _UX §1.2_ 🔶

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant Other as Any app
    participant Sheet as OS Share Sheet
    participant Stash
    participant Store as Local store

    U->>Other: tap Share
    Other->>Sheet: URL / text payload
    U->>Sheet: choose Stash
    Sheet->>Stash: deliver payload (+ page title when provided)
    Stash->>Stash: extract first URL from text
    alt a link is found
        Stash->>Store: persist locally first (never waits on cloud)
        Stash-->>U: ~2s toast "Saved to Stash" / "Already in Stash"
    else no link
        Stash-->>U: toast "No link found to stash"
    end
    Note over U: user stays in their original flow
```

---

## 3. Browse, search & organize

```mermaid
flowchart TD
    start([Open Stash]) --> inbox["Inbox — active bookmarks, newest first"]
    inbox --> search["Search: case-insensitive over<br/>title / description / notes / URL (terms AND)"]
    inbox --> facets{"Facet chip bar<br/>(shown when ≥1 collection or tag)"}
    facets -->|All| inbox
    facets -->|No collection| inbox
    facets -->|per collection| inbox
    facets -->|per tag| inbox
    search --> inbox

    inbox -->|tap card body| detail["Bookmark Detail"]
    inbox -->|Open ↗| browser["System browser"]

    detail --> edit["Edit title / notes (local-first)"]
    detail --> tags["Add / remove tags · file into collection"]
    detail --> openlink["Open link ↗"]
    detail --> archive["Archive / Unarchive (optimistic)"]
    detail --> del["Delete (confirm → durable remote delete)"]
    tags -->|tap a tag| inbox
```

_References: Inbox & facets UX §2, Detail UX §3, Archive UX §4, Delete UX §5,
Tags/collections UX §11, Search/editing UX §12._

---

## 4. Metadata enrichment (background) — _UX §6_

```mermaid
stateDiagram-v2
    [*] --> pending: bookmark saved
    pending --> complete: page fetched —<br/>OpenGraph / Twitter / title / favicon / preview
    pending --> failed: fetch error (save never fails)
    pending --> skipped: nothing to enrich
    complete --> [*]
    failed --> pending: re-tried on next launch
    note right of complete
        Never overwrites user-entered values.
        URL-derived values fill gaps (offline saves
        still get a sensible title). Once complete,
        metadata is pushed to Supabase so other
        devices receive it on their next pull.
    end note
```

---

## 5. AI suggestions (server-side auto-tagging) — _UX §7_

Enrichment is produced by the `ai-enrich` edge function behind a **swappable
`EnrichmentProvider` seam** (a deterministic `DummyProvider` ships today). The
user always stays in control — high-confidence tags are surfaced, never
auto-applied.

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant Fn as ai-enrich (edge fn)
    participant Prov as EnrichmentProvider
    participant DB as Postgres (RLS)

    App->>Fn: POST bookmark id (forwards user JWT)
    Fn->>Prov: run provider (Dummy today, model later)
    Prov-->>Fn: summary, topics, suggested tags+confidence, collection
    Fn->>DB: write ai_enrichments row (model, status)
    Fn-->>App: enrichment (surfaces immediately, and again on next pull)
    Note over App: only tags with confidence ≥ 0.6 shown<br/>(pendingSuggestions filters applied + low-confidence)
    App->>App: Accept tag → link source:'ai' · Accept collection → file
    Note over App: editing title/notes ⇒ enrichment goes 'stale'<br/>→ "Refresh AI suggestions" regenerates
```

The **Review queue** (`/review`, from Settings) batches every Inbox bookmark
with pending suggestions for per-tag or "Accept all" actions.

---

## 6. Cloud sync — _UX §8–11_

Local save is the source of immediate confirmation; the cloud is eventually
consistent. Upload drains first, then pull — **local pending work always wins
until uploaded.**

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant Q as Local queue
    participant DB as Supabase (Postgres + RLS)

    Note over App,DB: Anonymous session created silently on first launch,<br/>tokens refresh near expiry (and before each run)

    rect rgb(235,245,255)
    Note right of App: Upload (creates / archives / deletes)
    App->>Q: enqueue mutation (records retries + last error)
    Q->>DB: upsert / update / delete (server-side URL dedupe)
    DB-->>Q: ok → mark synced (retries never duplicate rows)
    end

    rect rgb(235,255,238)
    Note right of App: Pull (incremental, after upload drains)
    App->>DB: fetch rows updated_at > watermark (−5m skew)
    DB-->>App: changed bookmarks + ai_enrichments + tags/collections
    App->>App: insert new · merge by id (last-write-wins)
    Note over App: a row with queued local mutations is never overwritten
    App->>DB: fetch remote id list → drop local synced rows now gone
    end
```

State of a single bookmark's `sync_status`:

```mermaid
stateDiagram-v2
    [*] --> pending: created / edited / archived / deleted locally
    pending --> synced: upload succeeds
    pending --> pending: retry on failure (error recorded)
    synced --> pending: local change re-queues
    synced --> [*]: remote row deleted elsewhere ⇒ removed locally
```

---

## 7. Observability

### 7.1 Feedback / issue reporting — _UX §13_ + feedback-bridge

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as Report screen (/report)
    participant DB as feedback_reports (RLS)
    participant Br as feedback-bridge (edge fn)
    participant Sink as ReportSink → SentrySink
    participant S as Sentry

    U->>R: pick Bug / Idea / Other + description
    Note over R: read-only diagnostics preview —<br/>version, platform, route, auth, queue depth,<br/>last error. NO bookmark contents.
    R->>DB: insert report (user reads/inserts only own rows)
    DB--)Br: INSERT webhook
    Br->>Sink: deliver (transport injectable)
    Sink->>S: event (message + redacted extra.diagnostics)
    Note over DB: report stays durably in the table<br/>regardless of delivery outcome
```

### 7.2 Crash & error monitoring — client SDK

`@sentry/react-native` captures unhandled JS/native errors automatically.
**Off until `EXPO_PUBLIC_SENTRY_DSN` is set**, so local/preview builds never
report by accident; `sendDefaultPii` is `false` and only the opaque anon user
id is attached.

```mermaid
flowchart LR
    boot([App boot]) --> init["initSentry() — no-op without a DSN"]
    init --> wrap["wrapWithSentry(RootLayout)"]
    auth["Auth session ready"] --> setuser["setSentryUser(anon id)"]
    crash[["Unhandled JS / native error"]] --> capture["Captured & grouped per device"]
    setuser --> capture
    capture --> sentry(("🛰️ Sentry"))
    release["v* tag pushed"] --> wf[".github/workflows/sentry-release.yml"] --> sentry
```

---

## 8. Use-case index

| # | Use case | Status | Spec |
|---|----------|--------|------|
| 1 | Manual add | ✅ | [§1.1](ux-spec.md) |
| 2 | Share intake | 🔶 | [§1.2](ux-spec.md) |
| 3 | Browse / search / facet filter | ✅ | [§2, §12](ux-spec.md) |
| 4 | View & edit bookmark detail | ✅ | [§3, §12](ux-spec.md) |
| 5 | Archive / unarchive | ✅ | [§4](ux-spec.md) |
| 6 | Delete (durable remote) | ✅ | [§5](ux-spec.md) |
| 7 | Background metadata enrichment | ✅ | [§6](ux-spec.md) |
| 8 | AI suggestions + review queue | ✅ | [§7](ux-spec.md) |
| 9 | Account & sync (upload + pull) | ✅ / 🔶 | [§8–11](ux-spec.md) |
| 10 | Tags & collections | ✅ | [§11](ux-spec.md) |
| 11 | Feedback / issue reporting → Sentry | ✅ / 🔶 | [§13](ux-spec.md) |
| 12 | Crash & error monitoring | — | (client SDK) |

---

_See also: [Product spec](product-spec.md) · [Architecture overview](../architecture/overview.md) · [Data model](../architecture/data-model.md) · [Bookmark API](../api/bookmarks.md)._
