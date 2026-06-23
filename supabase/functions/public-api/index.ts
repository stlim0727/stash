// Supabase Edge Function: public-api
//
// Public REST API. Authenticated by API key issued from the api-keys function.
//
// Routes:
//   GET    /functions/v1/public-api/bookmarks              list (paginated, searchable)
//   POST   /functions/v1/public-api/bookmarks              create (with URL dedup)
//   GET    /functions/v1/public-api/bookmarks/:id          detail (with tags + collection)
//   PATCH  /functions/v1/public-api/bookmarks/:id          update
//   DELETE /functions/v1/public-api/bookmarks/:id          archive (or ?permanent=true)
//   POST   /functions/v1/public-api/bookmarks/:id/tags     add tags
//   DELETE /functions/v1/public-api/bookmarks/:id/tags     remove tags
//   GET    /functions/v1/public-api/collections            list
//   POST   /functions/v1/public-api/collections            create
//   GET    /functions/v1/public-api/tags                   list

import { canonicalizeUrl, normalizeUrl } from '../_shared/urls.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveUserIdFromApiKey(authorization: string | null): Promise<string | null> {
  if (!authorization?.startsWith('Bearer stash_')) return null;
  const key = authorization.slice('Bearer '.length);
  const hash = await sha256(key);

  const res = await db('GET', `api_keys?key_hash=eq.${hash}&revoked_at=is.null&select=id,user_id&limit=1`);
  if (!res.ok) return null;
  const rows: Array<{ id: string; user_id: string }> = await res.json();
  if (!rows[0]) return null;

  // Update last_used_at fire-and-forget — don't await so it doesn't slow the request
  void db('PATCH', `api_keys?id=eq.${rows[0].id}`, { last_used_at: new Date().toISOString() });

  return rows[0].user_id;
}

async function db(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : method === 'PATCH' ? 'return=representation' : 'return=minimal',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function validateCollectionOwnership(userId: string, collectionId: string): Promise<boolean> {
  const res = await db('GET', `collections?id=eq.${collectionId}&user_id=eq.${userId}&select=id&limit=1`);
  if (!res.ok) return false;
  const rows: unknown[] = await res.json();
  return rows.length > 0;
}

// URL utilities are shared with the chat function so both compute the same
// canonical `url_hash`. See ../_shared/urls.ts.

// Tag utilities (ported from apps/mobile/src/domain/tag-normalize.ts)
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function slugify(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueNormalizedTags(tags: string[]): Array<{ name: string; slug: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; slug: string }> = [];
  for (const tag of tags) {
    const name = normalizeText(tag);
    const slug = slugify(name);
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    result.push({ name, slug });
  }
  return result;
}

function inFilter(values: string[]): string {
  return `(${values.join(',')})`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function listBookmarks(userId: string, url: URL): Promise<Response> {
  const p = url.searchParams;
  const limit = Math.min(parseInt(p.get('limit') ?? '50', 10) || 50, 100);
  const offset = parseInt(p.get('offset') ?? '0', 10) || 0;
  const query = p.get('q') ?? '';
  const collectionId = p.get('collection_id');
  const isArchived = p.get('is_archived');
  const sortParam = p.get('sort') ?? 'created_at_desc';
  const sortMap: Record<string, string> = {
    created_at_desc: 'created_at.desc',
    created_at_asc: 'created_at.asc',
    updated_at_desc: 'updated_at.desc',
    updated_at_asc: 'updated_at.asc',
  };
  const order = sortMap[sortParam] ?? 'created_at.desc';

  const qs = new URLSearchParams({
    user_id: `eq.${userId}`,
    order,
    limit: String(limit),
    offset: String(offset),
  });

  if (query) qs.set('or', `(title.ilike.*${query}*,url.ilike.*${query}*,notes.ilike.*${query}*,description.ilike.*${query}*)`);
  if (collectionId) qs.set('collection_id', collectionId === 'null' ? 'is.null' : `eq.${collectionId}`);
  if (isArchived !== null && isArchived !== undefined) qs.set('is_archived', `eq.${isArchived === 'true'}`);
  else qs.set('is_archived', 'eq.false');

  const res = await db('GET', `bookmarks?${qs}`);
  if (!res.ok) return json({ error: 'Failed to list bookmarks' }, 500);
  const bookmarks = await res.json();
  return json({ bookmarks, limit, offset });
}

async function createBookmark(userId: string, body: Record<string, unknown>): Promise<Response> {
  const url = typeof body.url === 'string' ? normalizeUrl(body.url) : null;
  const sharedText = typeof body.shared_text === 'string' ? body.shared_text.trim() : null;

  if (!url && !sharedText) {
    return json({ error: 'url or shared_text is required' }, 400);
  }

  const urlHash = url ? canonicalizeUrl(url) : null;
  const timestamp = nowIso();

  // Dedup check
  if (urlHash) {
    const existing = await db('GET', `bookmarks?user_id=eq.${userId}&url_hash=eq.${encodeURIComponent(urlHash)}&is_archived=eq.false&limit=1`);
    if (existing.ok) {
      const rows: Array<{ id: string; metadata_status: string }> = await existing.json();
      if (rows[0]) {
        await db('PATCH', `bookmarks?id=eq.${rows[0].id}&user_id=eq.${userId}`, { last_saved_at: timestamp, updated_at: timestamp });
        return json({ bookmark_id: rows[0].id, status: 'duplicate', metadata_status: rows[0].metadata_status });
      }
    }
  }

  const createBody = {
    user_id: userId,
    url,
    url_hash: urlHash,
    title: typeof body.title === 'string' ? body.title.trim() || null : null,
    description: typeof body.description === 'string' ? body.description.trim() || null : (sharedText || null),
    notes: typeof body.notes === 'string' ? body.notes.trim() || null : null,
    source_app: typeof body.source_app === 'string' ? body.source_app.trim() || null : 'api',
    content_type: url ? 'url' : 'text',
    collection_id: typeof body.collection_id === 'string'
      ? (await validateCollectionOwnership(userId, body.collection_id) ? body.collection_id : null)
      : null,
    is_archived: false,
    created_at: timestamp,
    updated_at: timestamp,
    last_saved_at: timestamp,
    metadata_status: 'pending',
  };

  const res = await db('POST', 'bookmarks', createBody);
  if (res.status === 409) return json({ error: 'Duplicate bookmark' }, 409);
  if (!res.ok) return json({ error: 'Failed to create bookmark' }, 500);

  const rows: Array<{ id: string; metadata_status: string }> = await res.json();
  const created = rows[0];
  if (!created) return json({ error: 'Unexpected error' }, 500);

  // Add tags if provided
  if (Array.isArray(body.tags) && body.tags.length > 0) {
    await addTagsToBookmark(userId, created.id, body.tags as string[]);
  }

  return json({ bookmark_id: created.id, status: 'created', metadata_status: created.metadata_status }, 201);
}

async function getBookmark(userId: string, bookmarkId: string): Promise<Response> {
  const [bRes, tagsRes] = await Promise.all([
    db('GET', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}&limit=1`),
    db('GET', `bookmark_tags?bookmark_id=eq.${bookmarkId}&select=tag_id`),
  ]);

  if (!bRes.ok) return json({ error: 'Failed to fetch bookmark' }, 500);
  const bookmarks: unknown[] = await bRes.json();
  if (!bookmarks[0]) return json({ error: 'Not found' }, 404);

  const bookmark = bookmarks[0] as Record<string, unknown>;

  let tags: unknown[] = [];
  if (tagsRes.ok) {
    const tagLinks: Array<{ tag_id: string }> = await tagsRes.json();
    if (tagLinks.length > 0) {
      const tagIds = tagLinks.map((t) => t.tag_id);
      const tRes = await db('GET', `tags?id=in.${inFilter(tagIds)}&user_id=eq.${userId}`);
      if (tRes.ok) tags = await tRes.json();
    }
  }

  let collection: unknown = null;
  if (typeof bookmark.collection_id === 'string') {
    const cRes = await db('GET', `collections?id=eq.${bookmark.collection_id}&user_id=eq.${userId}&limit=1`);
    if (cRes.ok) {
      const cols: unknown[] = await cRes.json();
      collection = cols[0] ?? null;
    }
  }

  return json({ bookmark, tags, collection });
}

async function updateBookmark(userId: string, bookmarkId: string, body: Record<string, unknown>): Promise<Response> {
  const allowed = ['title', 'description', 'notes', 'is_archived'];
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }

  // Validate collection_id ownership before writing — service-role key bypasses RLS
  if ('collection_id' in body) {
    if (body.collection_id === null) {
      patch.collection_id = null;
    } else if (typeof body.collection_id === 'string') {
      const owned = await validateCollectionOwnership(userId, body.collection_id);
      if (!owned) return json({ error: 'collection_id not found' }, 400);
      patch.collection_id = body.collection_id;
    }
  }

  // Handle tags separately
  const addTags = Array.isArray(body.add_tags) ? body.add_tags as string[] : null;
  const removeTags = Array.isArray(body.remove_tags) ? body.remove_tags as string[] : null;

  const res = await db('PATCH', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}`, patch);
  if (!res.ok) return json({ error: 'Failed to update bookmark' }, 500);
  const rows: unknown[] = await res.json();
  if (!rows[0]) return json({ error: 'Not found' }, 404);

  if (addTags && addTags.length > 0) await addTagsToBookmark(userId, bookmarkId, addTags);
  if (removeTags && removeTags.length > 0) await removeTagsFromBookmark(userId, bookmarkId, removeTags);

  return json(rows[0]);
}

async function deleteBookmark(userId: string, bookmarkId: string, permanent: boolean): Promise<Response> {
  if (!permanent) {
    const res = await db('PATCH', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}`, {
      is_archived: true,
      updated_at: nowIso(),
    });
    if (!res.ok) return json({ error: 'Failed to archive bookmark' }, 500);
    return new Response(null, { status: 204 });
  }

  const res = await db('DELETE', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}`);
  if (!res.ok) return json({ error: 'Failed to delete bookmark' }, 500);
  return new Response(null, { status: 204 });
}

async function ensureTag(userId: string, name: string, slug: string): Promise<{ id: string; name: string; slug: string }> {
  const existing = await db('GET', `tags?user_id=eq.${userId}&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (existing.ok) {
    const rows: Array<{ id: string; name: string; slug: string }> = await existing.json();
    if (rows[0]) return rows[0];
  }
  const timestamp = nowIso();
  const created = await db('POST', 'tags', { user_id: userId, name, slug, source: 'user', created_at: timestamp });
  if (!created.ok) throw new Error(`Failed to create tag: ${slug}`);
  const rows: Array<{ id: string; name: string; slug: string }> = await created.json();
  return rows[0]!;
}

async function addTagsToBookmark(userId: string, bookmarkId: string, tagNames: string[]): Promise<void> {
  const normalized = uniqueNormalizedTags(tagNames);
  if (normalized.length === 0) return;
  const tags = await Promise.all(normalized.map((t) => ensureTag(userId, t.name, t.slug)));
  const timestamp = nowIso();
  await db('POST', 'bookmark_tags', tags.map((tag) => ({
    bookmark_id: bookmarkId,
    tag_id: tag.id,
    source: 'user',
    created_at: timestamp,
  })));
  // Ignore conflicts (tag already attached) — Prefer header handles it via upsert below
}

async function addTagsRoute(userId: string, bookmarkId: string, body: Record<string, unknown>): Promise<Response> {
  const tagNames = Array.isArray(body.tags) ? body.tags as string[] : [];
  if (tagNames.length === 0) return json({ error: 'tags array is required' }, 400);

  // Verify bookmark ownership
  const bRes = await db('GET', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}&select=id&limit=1`);
  if (!bRes.ok || !((await bRes.json()) as unknown[])[0]) return json({ error: 'Not found' }, 404);

  const normalized = uniqueNormalizedTags(tagNames);
  const tags = await Promise.all(normalized.map((t) => ensureTag(userId, t.name, t.slug)));
  const timestamp = nowIso();

  const inserts = tags.map((tag) => ({ bookmark_id: bookmarkId, tag_id: tag.id, source: 'user', created_at: timestamp }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bookmark_tags`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(inserts),
  });
  if (!res.ok && res.status !== 409) return json({ error: 'Failed to add tags' }, 500);
  return json({ added: tags.map((t) => t.name) });
}

async function removeTagsFromBookmark(userId: string, bookmarkId: string, tagNames: string[]): Promise<void> {
  const normalized = uniqueNormalizedTags(tagNames);
  if (normalized.length === 0) return;
  const slugs = normalized.map((t) => t.slug);
  const tRes = await db('GET', `tags?user_id=eq.${userId}&slug=in.${inFilter(slugs)}&select=id`);
  if (!tRes.ok) return;
  const rows: Array<{ id: string }> = await tRes.json();
  if (rows.length === 0) return;
  const tagIds = rows.map((r) => r.id);
  await db('DELETE', `bookmark_tags?bookmark_id=eq.${bookmarkId}&tag_id=in.${inFilter(tagIds)}`);
}

async function removeTagsRoute(userId: string, bookmarkId: string, body: Record<string, unknown>): Promise<Response> {
  const tagNames = Array.isArray(body.tags) ? body.tags as string[] : [];
  if (tagNames.length === 0) return json({ error: 'tags array is required' }, 400);

  const bRes = await db('GET', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}&select=id&limit=1`);
  if (!bRes.ok || !((await bRes.json()) as unknown[])[0]) return json({ error: 'Not found' }, 404);

  await removeTagsFromBookmark(userId, bookmarkId, tagNames);
  return new Response(null, { status: 204 });
}

async function listCollections(userId: string): Promise<Response> {
  const res = await db('GET', `collections?user_id=eq.${userId}&order=name.asc`);
  if (!res.ok) return json({ error: 'Failed to list collections' }, 500);
  return json(await res.json());
}

async function createCollection(userId: string, body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === 'string' ? normalizeText(body.name) : '';
  if (!name) return json({ error: 'name is required' }, 400);
  const timestamp = nowIso();
  const res = await db('POST', 'collections', {
    user_id: userId,
    name,
    description: typeof body.description === 'string' ? body.description.trim() || null : null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  if (!res.ok) return json({ error: 'Failed to create collection' }, 500);
  const rows: unknown[] = await res.json();
  return json(rows[0], 201);
}

async function listTags(userId: string): Promise<Response> {
  const res = await db('GET', `tags?user_id=eq.${userId}&order=name.asc`);
  if (!res.ok) return json({ error: 'Failed to list tags' }, 500);
  return json(await res.json());
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

function buildOpenApiSpec(baseUrl: string): unknown {
  const serverUrl = `${baseUrl}/functions/v1/public-api`;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Stash API',
      description:
        'Read and organize your Stash bookmarks. Authenticate with an API key from Settings → API Keys in the Stash app.',
      version: '1.0.0',
    },
    servers: [{ url: serverUrl }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'stash_<key>',
          description: 'API key issued from the Stash app (Settings → API Keys).',
        },
      },
      schemas: {
        Bookmark: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            url: { type: 'string', nullable: true },
            title: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            notes: { type: 'string', nullable: true },
            content_type: { type: 'string', enum: ['url', 'article', 'image', 'video', 'text', 'unknown'] },
            collection_id: { type: 'string', format: 'uuid', nullable: true },
            is_archived: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        BookmarkDetail: {
          type: 'object',
          properties: {
            bookmark: { '$ref': '#/components/schemas/Bookmark' },
            tags: { type: 'array', items: { '$ref': '#/components/schemas/Tag' } },
            collection: { '$ref': '#/components/schemas/Collection', nullable: true },
          },
        },
        Collection: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Tag: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            slug: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
    paths: {
      '/bookmarks': {
        get: {
          operationId: 'listBookmarks',
          summary: 'List bookmarks',
          description: 'Returns a paginated list of bookmarks. Defaults to non-archived bookmarks sorted by newest first.',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search across title, URL, notes, and description.' },
            { name: 'collection_id', in: 'query', schema: { type: 'string' }, description: 'Filter by collection UUID, or "null" for uncollected bookmarks.' },
            { name: 'is_archived', in: 'query', schema: { type: 'boolean' }, description: 'Include archived bookmarks (default: false).' },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created_at_desc', 'created_at_asc', 'updated_at_desc', 'updated_at_asc'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Paginated bookmark list',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  bookmarks: { type: 'array', items: { '$ref': '#/components/schemas/Bookmark' } },
                  limit: { type: 'integer' },
                  offset: { type: 'integer' },
                },
              } } },
            },
            '401': { description: 'Invalid or missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
        post: {
          operationId: 'createBookmark',
          summary: 'Create a bookmark',
          description: 'Saves a new bookmark. If the URL already exists in the library, returns the existing bookmark ID with status "duplicate".',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The URL to bookmark.' },
                title: { type: 'string' },
                description: { type: 'string' },
                notes: { type: 'string', description: 'Private notes (user-authored, never overwritten by AI).' },
                collection_id: { type: 'string', format: 'uuid' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to attach.' },
                shared_text: { type: 'string', description: 'Raw text note (use instead of url for non-URL bookmarks).' },
              },
            } } },
          },
          responses: {
            '201': {
              description: 'Bookmark created',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  bookmark_id: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['created', 'duplicate'] },
                  metadata_status: { type: 'string' },
                },
              } } },
            },
            '400': { description: 'Missing required fields', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '401': { description: 'Invalid or missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
      },
      '/bookmarks/{id}': {
        get: {
          operationId: 'getBookmark',
          summary: 'Get a bookmark',
          description: 'Returns full bookmark detail including tags and collection.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Bookmark detail', content: { 'application/json': { schema: { '$ref': '#/components/schemas/BookmarkDetail' } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
        patch: {
          operationId: 'updateBookmark',
          summary: 'Update a bookmark',
          description: 'Updates user-authored fields. Use add_tags / remove_tags to manage tags inline.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                title: { type: 'string', nullable: true },
                description: { type: 'string', nullable: true },
                notes: { type: 'string', nullable: true },
                collection_id: { type: 'string', format: 'uuid', nullable: true },
                is_archived: { type: 'boolean' },
                add_tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to add.' },
                remove_tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to remove.' },
              },
            } } },
          },
          responses: {
            '200': { description: 'Updated bookmark', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Bookmark' } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
        delete: {
          operationId: 'deleteBookmark',
          summary: 'Archive or delete a bookmark',
          description: 'Archives the bookmark by default (recoverable). Pass ?permanent=true to permanently delete.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            '204': { description: 'Success' },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
      },
      '/bookmarks/{id}/tags': {
        post: {
          operationId: 'addTags',
          summary: 'Add tags to a bookmark',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['tags'],
              properties: { tags: { type: 'array', items: { type: 'string' } } },
            } } },
          },
          responses: {
            '200': { description: 'Tags added', content: { 'application/json': { schema: { type: 'object', properties: { added: { type: 'array', items: { type: 'string' } } } } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
        delete: {
          operationId: 'removeTags',
          summary: 'Remove tags from a bookmark',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['tags'],
              properties: { tags: { type: 'array', items: { type: 'string' } } },
            } } },
          },
          responses: {
            '204': { description: 'Tags removed' },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
      },
      '/collections': {
        get: {
          operationId: 'listCollections',
          summary: 'List collections',
          responses: {
            '200': { description: 'Collections', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Collection' } } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
        post: {
          operationId: 'createCollection',
          summary: 'Create a collection',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            } } },
          },
          responses: {
            '201': { description: 'Collection created', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Collection' } } } },
            '400': { description: 'Missing name', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
      },
      '/tags': {
        get: {
          operationId: 'listTags',
          summary: 'List tags',
          responses: {
            '200': { description: 'Tags', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Tag' } } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);

  // OpenAPI spec is public — no auth needed
  const isOpenApi = (url.pathname.endsWith('/openapi.json') || url.pathname.endsWith('/openapi')) && req.method === 'GET';
  if (isOpenApi) {
    const baseUrl = `https://${url.host}`;
    return new Response(JSON.stringify(buildOpenApiSpec(baseUrl), null, 2), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const userId = await resolveUserIdFromApiKey(req.headers.get('Authorization'));
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  // Runtime strips /functions/v1 but keeps the function name, so pathname is /public-api/...
  const path = url.pathname.replace(/^\/[^/]+\/?/, '');
  const parts = path.split('/').filter(Boolean);
  // parts: [] | ['bookmarks'] | ['bookmarks', ':id'] | ['bookmarks', ':id', 'tags'] | ['collections'] | ['tags']

  const resource = parts[0];
  const resourceId = parts[1];
  const subResource = parts[2];
  const method = req.method;

  const body: Record<string, unknown> = ['POST', 'PATCH', 'DELETE'].includes(method) && req.headers.get('content-type')?.includes('application/json')
    ? await req.json().catch(() => ({}))
    : {};

  // Bookmarks
  if (resource === 'bookmarks') {
    if (!resourceId) {
      if (method === 'GET') return listBookmarks(userId, url);
      if (method === 'POST') return createBookmark(userId, body);
    } else if (!subResource) {
      if (method === 'GET') return getBookmark(userId, resourceId);
      if (method === 'PATCH') return updateBookmark(userId, resourceId, body);
      if (method === 'DELETE') return deleteBookmark(userId, resourceId, url.searchParams.get('permanent') === 'true');
    } else if (subResource === 'tags') {
      if (method === 'POST') return addTagsRoute(userId, resourceId, body);
      if (method === 'DELETE') return removeTagsRoute(userId, resourceId, body);
    }
  }

  // Collections
  if (resource === 'collections') {
    if (!resourceId) {
      if (method === 'GET') return listCollections(userId);
      if (method === 'POST') return createCollection(userId, body);
    }
  }

  // Tags
  if (resource === 'tags' && !resourceId && method === 'GET') {
    return listTags(userId);
  }

  return json({ error: 'Not found' }, 404);
});
