# `ai-enrich` edge function

Backend producer of AI enrichments for bookmarks. The mobile app POSTs a
bookmark id; this function runs the configured provider, writes an
`ai_enrichments` row, and returns it. The client shows the result immediately
and re-reads it on the next pull sync.

```
POST /functions/v1/ai-enrich
Authorization: Bearer <user JWT>
{ "bookmark_id": "<uuid>", "locale": "ko", "metadata": { ...freshest fields } }
→ 200 { ...ai_enrichment row }
```

`locale` (optional) is the user's active language; a model-backed provider writes
the summary and tags in it (defaults to English). `metadata` (optional) carries
the device's freshest content fields so the model reasons about the real
title/site even when the stored row still lags behind on-device enrichment.

The caller's JWT is forwarded to PostgREST, so Row Level Security scopes every
read and write to the bookmark's owner. On this app path the function holds no
service-role key.

## Server-side trigger (enrich even when the app is away)

The app only fires this function while it is running. A link shared and then
dismissed — or a bookmark owned by another device — could sit in the cloud with
no suggestions until the owning app next opens. A database trigger closes that
gap: when a bookmark's `metadata_status` transitions out of `pending` (the model
now has a real title/site, not the bare captured URL) and nothing has enriched
it yet, `dispatch_ai_enrichment` (see
`supabase/migrations/20260621000000_ai_enrich_server_trigger.sql`) calls this
function over `pg_net`.

A trigger has no user session, so it authenticates with a shared secret header
instead of a JWT:

```
POST /functions/v1/ai-enrich
x-ai-enrich-secret: <shared secret>
{ "bookmark_id": "<uuid>", "user_id": "<uuid>" }
→ 200 { ...ai_enrichment row }  |  200 { "skipped": "already_enriched" }
```

On this path the function uses the service-role key (auto-injected as
`SUPABASE_SERVICE_ROLE_KEY`) and scopes all work to the bookmark's owner by
`user_id` by hand. The secret is compared in constant time (`request-auth.ts`);
a wrong secret is `401` and never downgraded to the app path. The same per-user
rate limit applies, via the `service_role`-only `request_ai_enrichment_slot_for`
variant. The client and trigger dedupe on the "already enriched?" check, so
whichever fires first wins and the other is a cheap no-op. Server-triggered
enrichment runs in English (a trigger has no per-user locale); in-app requests
still pass `locale`.

**Setup.** Set the function secret and tell the database where to call:

```bash
# 1. The shared secret the function checks for.
supabase secrets set AI_ENRICH_TRIGGER_SECRET="$(openssl rand -hex 32)"

# 2. The same secret + the function URL, in Vault, for the trigger to read.
#    Run in the SQL editor (service-role):
#    select vault.create_secret('https://<ref>.functions.supabase.co/ai-enrich', 'ai_enrich_url');
#    select vault.create_secret('<same secret as step 1>', 'ai_enrich_secret');
```

Until both Vault secrets exist the trigger is a safe no-op (it never aborts a
bookmark write), so the migration can deploy ahead of the secret being set.

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
| `request-auth.ts`    | Pure caller-auth decision: app JWT vs server-trigger shared secret |
| `index.ts`           | Deno HTTP shell: auth → load bookmark → rate-limit → provider → upsert row |
| `*.test.ts`          | Node unit tests for the providers + auth (run by `pnpm test`)   |

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
  to configure; the pipeline works out of the box. The heuristic tags/topics and
  summary are localized to the caller's `locale` (currently en/ko) so the
  fallback — including the degraded path below — still answers in the user's
  language; the collection hint stays as-is. When no keyword rule matches, the
  fallback suggests no tag at all rather than inventing a low-confidence
  host-derived one the app would only filter out as noise.
- **`GEMINI_API_KEY` set** → a single structured-output Gemini call produces the
  note (summary), topics, tags-with-confidence, and a collection routing hint.
  The user's existing collection names are passed in so the model routes into a
  bucket that already exists. The summary/tags/topics are requested in the
  caller's `locale`; the collection name is not (it must match an existing name
  verbatim). If the live call fails (rate limit / outage / malformed response),
  the request degrades to the heuristics instead of erroring, and the saved
  `model` reflects which provider actually ran.

### Degraded mode (visible, not silent)

When the result comes from the heuristic fallback, the row records `degraded =
true` and a coarse `degraded_reason` — `not_configured` (no key), `rate_limited`
(429 / free-tier `limit:0`), `timeout`, or `provider_error`. The app reads these
to show a calm "basic suggestions" note with the cause, so a rate-limit/outage is
never mistaken for real AI output (issue #101).

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
