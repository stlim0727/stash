# `chat` edge function — assistant over your bookmarks

A "chat with your bookmarks" assistant that can also **act** on the library
(save, tag, file into collections, trash). Authenticated by either a Supabase
session JWT (our own mobile / web clients) or a `stash_` API key (external
clients, e.g. a Custom GPT). Designed to serve many users cheaply: the model is
**swappable** behind a seam, and every mutating action is **confirmed by the
user** before it runs.

This is a scaffold — the architecture and the confirm flow are complete and
unit-tested; a few executor details and the clients are stubbed (see
[TODO](#todo)).

## Why this shape

A bookmark chatbot is **Claude/Gemini + tool use**: each tool is one Stash
operation (mirroring `docs/api/bookmarks.md` / `public-api`). The model decides
which tools to call; we execute them scoped to the authenticated user and feed
results back until it has an answer.

Composio and the ChatGPT/Claude *connectors* are a different thing — they let a
power user plug Stash into *their own* ChatGPT/Claude. They don't give us a
chatbot to ship. So we build the loop ourselves and keep the model provider
swappable.

## Files

| File | Role | Runtime |
|---|---|---|
| `chat-protocol.ts` | Provider-neutral transcript / tool-call / result / confirm types | pure |
| `chat-tools.ts` | The tool registry (`read` vs `mutating`) + confirm copy | pure |
| `chat-provider.ts` | `ChatProvider` seam + injectable `FetchLike` | pure |
| `chat-loop.ts` | Provider-agnostic agent loop + confirm-before-acting | pure |
| `gemini-chat-provider.ts` | Adapter: Google Gemini (Flash) function calling | pure (fetch injected) |
| `claude-chat-provider.ts` | Adapter: Anthropic Messages (Haiku) tool use | pure (fetch injected) |
| `index.ts` | Deno glue: auth, provider select, user-scoped executor | Deno |
| `*.test.ts` | Node-runner tests for the pure pieces | Node |

The pure modules carry no Deno/Node imports (like the `ai-enrich` seam), so they
run unchanged in the edge function and are unit-tested under
`pnpm test:functions`.

## Swapping the model

Set `CHAT_MODEL_PROVIDER` (`gemini` | `claude`) and the matching key. The loop,
tools, and clients don't change — only which adapter `index.ts` constructs.

```
CHAT_MODEL_PROVIDER=gemini   GEMINI_API_KEY=...      # cheapest; reuses ai-enrich's key
CHAT_MODEL_PROVIDER=claude   ANTHROPIC_API_KEY=...    # best tool-call reliability + caching
CHAT_MODEL=<override>                                  # optional model id override
```

**Choosing:** start on Gemini Flash (cheapest, already in the stack), and
benchmark Claude Haiku on the *act*-heavy flows (tag/file/create) — pick by
cost-per-*successful*-action, not sticker price. At scale the real cost levers
are **prompt caching** of the system prompt + tool schemas (a stable prefix
resent every round-trip) and **minimizing tool round-trips**, not the per-token
rate.

## Confirm-before-acting protocol

The function is **stateless** — the client stores the transcript and resends it
each turn.

1. Client `POST`s `{ messages: Turn[] }`.
2. The loop runs read tools automatically. When the model calls a **mutating**
   tool, the loop **stops and executes nothing**, returning:
   ```json
   { "status": "confirmation_required", "text": "...", "pending": [
       { "call_id": "m1", "name": "create_bookmark", "input": {...}, "summary": "Save “https://…”?" }
     ], "transcript": [ ... ] }
   ```
3. Client shows `summary` with Approve / Reject.
4. On a verdict, client resends `{ messages: <returned transcript>, decision: { call_id, decision } }`.
   The loop executes the approved call (or records the refusal), then continues
   until it returns `{ "status": "message", "text", "transcript" }`.

Unknown tool names are treated as mutating (fail safe → confirm). Every tool
runs scoped to the authenticated `user_id`; a `user_id` is never taken from
model output.

## TODO (before production)

- ~~**`create_bookmark` dedup**~~: done — `url_hash = canonicalizeUrl(url)` via
  the shared `../_shared/urls.ts` (now used by `public-api` too), plus an
  active-URL dedup lookup that reuses the existing row. (#184)
- ~~**`add_tags` executor**~~: done — ports `public-api`'s find-or-create tag +
  `bookmark_tags` merge-duplicates upsert; `create_bookmark` now applies its
  `tags` too. (#183)
- **Streaming**: replies are returned whole. For a chat UX, stream tokens (SSE)
  — the adapters would expose a streaming `complete`.
- ~~**Prompt caching**~~: done for Claude — `cache_control` breakpoint on the
  system block caches tools+system (kicks in once the prefix passes the
  per-model minimum). Gemini Flash applies *implicit* caching automatically; an
  explicit `CachedContent` resource is a later optimization. (#188)
- **Clients**: the mobile chat screen (`apps/mobile/src/app/chat.tsx` +
  `src/api/chat.ts`) is done (#185) — message list, Approve/Reject confirm UI,
  auth via the app's JWT. The separate web chat (#186) is still to come.
  (To keep the confirm pause 1:1, the loop runs one tool call per turn —
  `disable_parallel_tool_use` on Claude + a system-prompt nudge.)
- ~~**Rate limiting**~~: done — migration `20260623120000_chat_rate_limit.sql`
  adds `request_chat_slot_for(uuid)` (service-role; sliding hour+day window) and
  the function consults it before the loop, returning 429 when over. Fails open
  until the migration is applied. (#189)

## Tests

```
pnpm test:functions          # whole lane
node --no-warnings --experimental-transform-types --test "supabase/functions/chat/**/*.test.ts"
```

Covers the tool registry (read/mutating classification, fail-safe), the loop
(reads auto-run, mutations pause for confirm, approve executes, reject records
the refusal, `maxSteps` guard), and both adapters' response parsing.
