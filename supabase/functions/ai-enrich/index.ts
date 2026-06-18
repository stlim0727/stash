// Supabase Edge Function: ai-enrich
//
// The backend producer of AI enrichments. The mobile client never generates
// suggestions itself — it POSTs a bookmark id here, this function runs the
// configured EnrichmentProvider, writes an `ai_enrichments` row, and returns
// it. The client picks the result up immediately from the response and again
// on its next pull sync.
//
// Auth: the caller's Supabase JWT is forwarded straight to PostgREST, so Row
// Level Security scopes every read/write to the bookmark's owner — this
// function holds no elevated privileges.
//
// To ship a real model: implement EnrichmentProvider in a new module and
// change the single `provider` assignment below. Nothing else in the function,
// the database, or the app needs to change.

import { DummyProvider } from './dummy-provider.ts';
import { GeminiProvider } from './gemini-provider.ts';
import type { EnrichmentOutput, EnrichmentProvider } from './provider.ts';

// ── The swappable seam ──────────────────────────────────────────────────────
// Use the Gemini-backed provider when an API key is configured; otherwise fall
// back to the deterministic, network-free heuristics so the pipeline still
// works with no external dependency. `fallbackProvider` also catches live-call
// failures (rate limits, outages) at request time below.
const fallbackProvider = new DummyProvider();

function selectProvider(): EnrichmentProvider {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (apiKey) {
    return new GeminiProvider({
      apiKey,
      model: Deno.env.get('GEMINI_MODEL') ?? undefined,
    });
  }
  return fallbackProvider;
}

const provider: EnrichmentProvider = selectProvider();
// ────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface BookmarkRow {
  id: string;
  user_id: string;
  url: string | null;
  title: string | null;
  description: string | null;
  notes: string | null;
  site_name: string | null;
  content_type: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  let bookmarkId: unknown;
  try {
    bookmarkId = (await req.json())?.bookmark_id;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof bookmarkId !== 'string' || !bookmarkId) {
    return json({ error: 'bookmark_id is required' }, 400);
  }

  // PostgREST as the calling user (RLS enforced).
  const rest = (path: string, init: RequestInit = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: ANON_KEY,
        Authorization: authorization,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  try {
    const bookmarkRes = await rest(
      `/bookmarks?id=eq.${bookmarkId}&select=id,user_id,url,title,description,notes,site_name,content_type&limit=1`,
    );
    if (!bookmarkRes.ok) {
      return json({ error: 'Failed to load bookmark' }, bookmarkRes.status);
    }
    const [bookmark] = (await bookmarkRes.json()) as BookmarkRow[];
    if (!bookmark) {
      return json({ error: 'Bookmark not found' }, 404);
    }

    // Load the user's collections up front: their names guide the provider
    // toward an existing bucket, and the same list resolves the returned name
    // hint to a real id below — never inventing or creating a collection here.
    let collections: Array<{ id: string; name: string }> = [];
    const colRes = await rest(`/collections?select=id,name`);
    if (colRes.ok) {
      collections = (await colRes.json()) as Array<{ id: string; name: string }>;
    }

    const input = {
      url: bookmark.url,
      title: bookmark.title,
      description: bookmark.description,
      notes: bookmark.notes,
      site_name: bookmark.site_name,
      content_type: bookmark.content_type,
      collections: collections.map((col) => col.name),
    };

    // Run the configured provider; if a live model call fails (rate limit,
    // outage, bad response), degrade to the deterministic heuristics rather
    // than failing the whole request.
    let output: EnrichmentOutput;
    let usedModel = provider.model;
    try {
      output = await provider.enrich(input);
    } catch (err) {
      if (provider === fallbackProvider) {
        throw err;
      }
      console.error('Primary enrichment provider failed; using fallback:', err);
      output = await fallbackProvider.enrich(input);
      usedModel = fallbackProvider.model;
    }

    // Resolve the collection NAME hint to one of the user's existing
    // collections; never create one here.
    const suggestedCollectionId = output.suggested_collection
      ? collections.find(
          (col) => col.name.toLowerCase() === output.suggested_collection!.toLowerCase(),
        )?.id ?? null
      : null;

    const now = new Date().toISOString();
    const row = {
      bookmark_id: bookmark.id,
      user_id: bookmark.user_id,
      summary: output.summary,
      topics: output.topics,
      suggested_tags: output.suggested_tags,
      suggested_collection_id: suggestedCollectionId,
      model: usedModel,
      status: 'complete',
      confidence: output.confidence,
      updated_at: now,
    };

    // Upsert the latest enrichment for this bookmark: patch in place if one
    // exists, otherwise insert. Keeps a single live row per bookmark.
    const existingRes = await rest(
      `/ai_enrichments?bookmark_id=eq.${bookmarkId}&select=id&order=created_at.desc&limit=1`,
    );
    const [existing] = existingRes.ok
      ? ((await existingRes.json()) as Array<{ id: string }>)
      : [];

    const saveRes = existing
      ? await rest(`/ai_enrichments?id=eq.${existing.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      : await rest(`/ai_enrichments`, {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ ...row, created_at: now }),
        });

    if (!saveRes.ok) {
      return json({ error: 'Failed to save enrichment' }, saveRes.status);
    }
    const [saved] = (await saveRes.json()) as unknown[];
    return json(saved, 200);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Enrichment failed' },
      500,
    );
  }
});
