# `ai-enrich` edge function

Backend producer of AI enrichments for bookmarks. The mobile app POSTs a
bookmark id; this function runs the configured provider, writes an
`ai_enrichments` row, and returns it. The client shows the result immediately
and re-reads it on the next pull sync.

```
POST /functions/v1/ai-enrich
Authorization: Bearer <user JWT>
{ "bookmark_id": "<uuid>" }
→ 200 { ...ai_enrichment row }
```

The caller's JWT is forwarded to PostgREST, so Row Level Security scopes every
read and write to the bookmark's owner. The function holds no service-role key.

## Rate limiting

Because every received bookmark auto-fires an enrichment and the app is
anonymous-first (anyone can mint a session), the function enforces a per-user
limit before calling a billable provider. The check is a DB function
(`request_ai_enrichment_slot`, see
`supabase/migrations/20260620000000_ai_enrichment_rate_limit.sql`) that atomically
records a slot against a sliding window — so it is race-free and scoped to
`auth.uid()` via the forwarded JWT. Over the limit returns `429` with a
`Retry-After` header; the client surfaces a calm message and lets the durable
auto-trigger retry later.

| Window       | Signed-in | Anonymous |
| ------------ | --------- | --------- |
| rolling hour | 30        | 10        |
| rolling day  | 200       | 50        |

The limit is **only** enforced when `GEMINI_API_KEY` is set (a real, billable
provider). With no key the network-free `DummyProvider` runs unthrottled, and a
missing/failing rate-limit function fails **open** so suggestions never break.

## Files

| File                 | Role                                                            |
| -------------------- | --------------------------------------------------------------- |
| `provider.ts`        | `EnrichmentProvider` interface + I/O types — the swappable seam |
| `dummy-provider.ts`  | `DummyProvider`: deterministic keyword heuristics, no network   |
| `gemini-provider.ts` | `GeminiProvider`: structured-output call to the Google Gemini API |
| `index.ts`           | Deno HTTP shell: auth → load bookmark → rate-limit → provider → upsert row |
| `*.test.ts`          | Node unit tests for the providers (run by `pnpm test`)          |

## Provider selection

`index.ts` picks a provider from the environment, with the heuristic provider
as a built-in fallback:

```ts
function selectProvider(): EnrichmentProvider {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (apiKey) return new GeminiProvider({ apiKey, model: Deno.env.get('GEMINI_MODEL') ?? undefined });
  return fallbackProvider; // DummyProvider
}
```

- **No key set** → deterministic heuristics, zero external calls. Nothing else
  to configure; the pipeline works out of the box.
- **`GEMINI_API_KEY` set** → a single structured-output Gemini call produces the
  note (summary), topics, tags-with-confidence, and a collection routing hint.
  The user's existing collection names are passed in so the model routes into a
  bucket that already exists. If the live call fails (rate limit / outage /
  malformed response), the request degrades to the heuristics instead of
  erroring, and the saved `model` reflects which provider actually ran.

### Configuration

| Env var          | Required | Default            | Notes                                  |
| ---------------- | -------- | ------------------ | -------------------------------------- |
| `GEMINI_API_KEY`   | no     | —                  | Enables `GeminiProvider` when present. |
| `GEMINI_MODEL`     | no     | `gemini-2.5-flash` | Any Gemini model id. (The 2.0 models have no free-tier quota.) |
| `GEMINI_TIMEOUT_MS`| no     | `15000`            | Aborts a hung request so it falls back. |

```bash
supabase secrets set GEMINI_API_KEY=...
```

The key lives only in the edge function's environment and never ships to the
mobile client — the app only ever POSTs a bookmark id and reads the result.

### Adding another model

Add a module implementing `EnrichmentProvider` (e.g. `claude-provider.ts`
calling the Anthropic API with a key from `Deno.env`), then extend
`selectProvider()`. The function shell, the database schema, the sync layer,
and the app UI all stay unchanged.

## Triggering

The app calls this function after a new bookmark first syncs, and on demand via
the "Suggest with AI" action in Bookmark Detail. In production it can also be
driven server-side (a database trigger / webhook on `bookmarks` insert) so the
client only ever pulls results — that wiring is independent of this function.

## Local development

```bash
supabase functions serve ai-enrich
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided by the Supabase runtime.
