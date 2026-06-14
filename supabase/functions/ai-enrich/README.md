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

## Files

| File                 | Role                                                            |
| -------------------- | --------------------------------------------------------------- |
| `provider.ts`        | `EnrichmentProvider` interface + I/O types — the swappable seam |
| `dummy-provider.ts`  | `DummyProvider`: deterministic keyword heuristics, no network   |
| `index.ts`           | Deno HTTP shell: auth → load bookmark → provider → upsert row    |
| `dummy-provider.test.ts` | Node unit tests for the heuristics (run by `pnpm test`)      |

## Swapping in a real model

The placeholder is wired at exactly one line in `index.ts`:

```ts
const provider: EnrichmentProvider = new DummyProvider();
```

To use a real model, add a module implementing `EnrichmentProvider` (e.g.
`claude-provider.ts` that calls the Anthropic API with a key from
`Deno.env`), then point that line at it. The function shell, the database
schema, the sync layer, and the app UI all stay unchanged.

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
