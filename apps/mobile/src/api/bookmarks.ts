import { normalizeText, slugify } from '@/domain/tag-normalize';
import { canonicalizeUrl, normalizeUrl } from '@/domain/urls';
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  CreateBookmarkInput,
  EnrichmentStatus,
  MetadataStatus,
  SuggestedTag,
  Tag,
  TagSource,
} from '@/domain/types';
import { createSupabaseClient, SupabaseRequestError } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

// `local_image_uri` is a device-only field (a captured image's on-disk URI),
// so it is never part of a remote row, alongside the local-only `sync_status`.
export type RemoteBookmark = Omit<Bookmark, 'sync_status' | 'local_image_uri'>;

export interface CreateBookmarkOutput {
  bookmark_id: string;
  status: 'created' | 'duplicate' | 'queued';
  metadata_status: MetadataStatus;
}

export interface ListBookmarksParams {
  query?: string;
  collection_id?: string | null;
  tag_ids?: string[];
  is_archived?: boolean;
  limit?: number;
  cursor?: string;
  sort?: 'created_at_desc' | 'created_at_asc' | 'updated_at_desc' | 'updated_at_asc';
}

export interface BookmarkDetail {
  bookmark: Bookmark;
  tags: Tag[];
  collection: Collection | null;
  enrichment: AIEnrichment | null;
}

export interface UpdateBookmarkInput {
  title?: string | null;
  description?: string | null;
  notes?: string | null;
  collection_id?: string | null;
  is_archived?: boolean;
  deleted_at?: string | null;
  // Generated metadata, pushed by sync once on-device enrichment completes so
  // other devices see the enriched title/site/favicon rather than the bare
  // create-time payload.
  site_name?: string | null;
  favicon_url?: string | null;
  preview_image_url?: string | null;
  metadata_status?: MetadataStatus;
}

export interface AddTagsInput {
  bookmark_id: string;
  tags: string[];
  source: TagSource;
}

export interface RemoveTagsInput {
  bookmark_id: string;
  tags: string[];
}

export interface UpdateAIEnrichmentInput {
  bookmark_id: string;
  summary?: string | null;
  topics?: string[];
  suggested_tags?: SuggestedTag[];
  suggested_collection_id?: string | null;
  status: EnrichmentStatus;
  model?: string | null;
  confidence?: number | null;
}

export interface ApplyAISuggestionsInput {
  bookmark_id: string;
  tag_names?: string[];
  collection_id?: string | null;
}

/**
 * The device's freshest content fields, passed to `requestEnrichment` so the
 * `ai-enrich` function can reason about real metadata even when the cloud row
 * still lags behind on-device OpenGraph enrichment. All optional: only non-empty
 * values are sent, and the server falls back to the stored row for the rest.
 */
export interface EnrichmentMetadataHint {
  title?: string | null;
  description?: string | null;
  notes?: string | null;
  site_name?: string | null;
  content_type?: string | null;
}

type PostgrestSort = 'created_at.desc' | 'created_at.asc' | 'updated_at.desc' | 'updated_at.asc';

type RemoteAIEnrichment = Omit<AIEnrichment, 'topics' | 'suggested_tags'> & {
  topics: unknown;
  suggested_tags: unknown;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueNormalizedTags(tags: string[]): Array<{ name: string; slug: string }> {
  const seen = new Set<string>();
  const normalized: Array<{ name: string; slug: string }> = [];

  for (const tag of tags) {
    const name = normalizeText(tag);
    const slug = slugify(name);
    if (!name || !slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    normalized.push({ name, slug });
  }

  return normalized;
}

function requirePayload(input: CreateBookmarkInput): { url: string | null; contentType: Bookmark['content_type'] } {
  if (input.url) {
    const normalized = normalizeUrl(input.url);
    if (!normalized) {
      throw new Error('createBookmark requires a valid URL when url is provided.');
    }

    return { url: normalized, contentType: 'url' };
  }

  if (input.shared_text?.trim()) {
    return { url: null, contentType: 'text' };
  }

  throw new Error('createBookmark requires either url or shared_text.');
}

function remoteToBookmark(row: RemoteBookmark): Bookmark {
  return { ...row, sync_status: 'synced' };
}

function enrichmentFromRemote(row: RemoteAIEnrichment): AIEnrichment {
  return {
    ...row,
    topics: Array.isArray(row.topics) ? (row.topics as string[]) : [],
    suggested_tags: Array.isArray(row.suggested_tags)
      ? (row.suggested_tags as SuggestedTag[])
      : [],
    // Tolerate pre-M12 rows (and any backend without the columns yet): absent →
    // not degraded. The column defaults to false server-side, but the mapper
    // stays defensive so a missing field can never read as `undefined`.
    degraded: row.degraded === true,
    degraded_reason: row.degraded ? row.degraded_reason ?? null : null,
    // Tolerate rows from before the column existed: absent → no new-collection
    // suggestion. (RemoteAIEnrichment spreads the column through; this just
    // guarantees null over undefined.)
    suggested_collection_name: row.suggested_collection_name ?? null,
  };
}

function inFilter(values: string[]): string {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(',')})`;
}

function sortParam(sort: ListBookmarksParams['sort']): PostgrestSort {
  switch (sort) {
    case 'created_at_asc':
      return 'created_at.asc';
    case 'updated_at_asc':
      return 'updated_at.asc';
    case 'updated_at_desc':
      return 'updated_at.desc';
    case 'created_at_desc':
    default:
      return 'created_at.desc';
  }
}

function appendSearchParams(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class BookmarkApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) {}

  async createBookmark(input: CreateBookmarkInput): Promise<CreateBookmarkOutput> {
    const payload = requirePayload(input);
    const timestamp = nowIso();
    const title = input.title?.trim() || null;
    const description = input.description?.trim() || input.shared_text?.trim() || null;
    const notes = input.notes?.trim() || null;
    const sourceApp = input.source_app?.trim() || null;

    // Dedupe on the canonical URL (tracking params / fragment stripped), the
    // same key the local store uses, so the server's active-URL unique index
    // and the client agree on what counts as "the same bookmark". Storing the
    // raw normalized URL here would let `…?utm_source=x` and the bare URL
    // become two separate cloud rows.
    const urlHash = payload.url ? canonicalizeUrl(payload.url) : null;
    const clientId = input.client_id ?? null;

    // Idempotent saves: reuse the existing row rather than inserting a twin. URL
    // saves dedupe on the canonical url_hash. URL-less rows (text notes) have no
    // such key, so they dedupe on the device-generated client_id — which a
    // retried upload resends unchanged, closing the gap that let an interrupted
    // text-note sync create a duplicate.
    const existing = urlHash
      ? await this.findActiveBookmarkByUrlHash(urlHash)
      : clientId
        ? await this.findBookmarkByClientId(clientId)
        : null;
    if (existing) {
      await this.updateBookmark(existing.id, { last_saved_at: timestamp });
      return {
        bookmark_id: existing.id,
        status: 'duplicate',
        metadata_status: existing.metadata_status,
      };
    }

    const createBody = {
      user_id: this.session.user.id,
      url: payload.url,
      canonical_url: null,
      url_hash: urlHash,
      client_id: clientId,
      title,
      description,
      notes,
      source_app: sourceApp,
      content_type: payload.contentType,
      preview_image_url: null,
      favicon_url: null,
      site_name: null,
      collection_id: null,
      is_archived: false,
      created_at: timestamp,
      updated_at: timestamp,
      last_saved_at: timestamp,
      metadata_status: 'pending',
    };

    let rows: RemoteBookmark[];
    try {
      rows = await this.client.request<RemoteBookmark[]>('/rest/v1/bookmarks', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: createBody,
      });
    } catch (error) {
      // If a concurrent (or retried) insert won the race between our lookup and
      // our own insert, treat the unique-index conflict as the documented
      // duplicate save. Try the active-URL key first, then fall back to the
      // client_id key: a retried URL create whose original was archived in the
      // meantime conflicts on the all-rows client_id index (not the active-only
      // url_hash one), so the url_hash lookup alone would miss the archived
      // original and leave the entry failing forever.
      if (error instanceof SupabaseRequestError && error.status === 409) {
        const duplicate =
          (urlHash ? await this.findActiveBookmarkByUrlHash(urlHash) : null) ??
          (clientId ? await this.findBookmarkByClientId(clientId) : null);
        if (duplicate) {
          return {
            bookmark_id: duplicate.id,
            status: 'duplicate',
            metadata_status: duplicate.metadata_status,
          };
        }
      }
      throw error;
    }

    const created = rows[0];
    if (!created) {
      throw new Error('Supabase did not return the created bookmark.');
    }

    return {
      bookmark_id: created.id,
      status: 'created',
      metadata_status: created.metadata_status,
    };
  }

  async listBookmarks(params: ListBookmarksParams = {}): Promise<Bookmark[]> {
    if (params.tag_ids && params.tag_ids.length > 0) {
      return this.listBookmarksByTags(params);
    }

    const query = this.baseBookmarkListParams(params);
    const rows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams('/rest/v1/bookmarks', query),
      { accessToken: this.session.access_token },
    );

    return rows.map(remoteToBookmark);
  }

  /** All bookmarks changed after `since` (all of them when null), oldest first. */
  async listBookmarksUpdatedSince(since: string | null): Promise<Bookmark[]> {
    const rows = await this.fetchAllPages<RemoteBookmark>('/rest/v1/bookmarks', (query) => {
      query.set('order', 'updated_at.asc,id.asc');
      if (since) {
        query.set('updated_at', `gt.${since}`);
      }
    });
    return rows.map(remoteToBookmark);
  }

  /** Every bookmark ID the user owns — used to detect remote deletions. */
  async listBookmarkIds(): Promise<string[]> {
    const rows = await this.fetchAllPages<{ id: string }>('/rest/v1/bookmarks', (query) => {
      query.set('select', 'id');
      query.set('order', 'id.asc');
    });
    return rows.map((row) => row.id);
  }

  /** AI enrichments changed after `since` (all of them when null), oldest first. */
  async listEnrichmentsUpdatedSince(since: string | null): Promise<AIEnrichment[]> {
    const rows = await this.fetchAllPages<RemoteAIEnrichment>('/rest/v1/ai_enrichments', (query) => {
      query.set('order', 'updated_at.asc,id.asc');
      if (since) {
        query.set('updated_at', `gt.${since}`);
      }
    });
    return rows.map(enrichmentFromRemote);
  }

  /** All of the user's tags. */
  async listTags(): Promise<Tag[]> {
    return this.fetchAllPages<Tag>('/rest/v1/tags', (query) => {
      query.set('order', 'name.asc,id.asc');
    });
  }

  /** All tag links for the user's bookmarks (RLS scopes them to the owner). */
  async listBookmarkTags(): Promise<BookmarkTag[]> {
    return this.fetchAllPages<BookmarkTag>('/rest/v1/bookmark_tags', (query) => {
      // bookmark_tags has no user_id column; RLS scopes rows to the owner.
      query.delete('user_id');
      query.set('order', 'bookmark_id.asc,tag_id.asc');
    });
  }

  /** All of the user's collections. */
  async listCollections(): Promise<Collection[]> {
    return this.fetchAllPages<Collection>('/rest/v1/collections', (query) => {
      query.set('order', 'name.asc,id.asc');
    });
  }

  async createCollection(name: string, description?: string): Promise<Collection> {
    const timestamp = nowIso();
    const rows = await this.client.request<Collection[]>('/rest/v1/collections', {
      method: 'POST',
      accessToken: this.session.access_token,
      headers: { Prefer: 'return=representation' },
      body: {
        user_id: this.session.user.id,
        name: normalizeText(name),
        description: description?.trim() || null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    const created = rows[0];
    if (!created) {
      throw new Error('Supabase did not return the created collection.');
    }
    return created;
  }

  private async fetchAllPages<T>(
    path: string,
    configure: (query: URLSearchParams) => void,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const query = new URLSearchParams({
        select: '*',
        user_id: `eq.${this.session.user.id}`,
        limit: String(MAX_PAGE_SIZE),
        offset: String(offset),
      });
      configure(query);
      const page = await this.client.request<T[]>(appendSearchParams(path, query), {
        accessToken: this.session.access_token,
      });
      all.push(...page);
      if (page.length < MAX_PAGE_SIZE) {
        return all;
      }
    }
  }

  async getBookmark(bookmarkId: string): Promise<BookmarkDetail | null> {
    const bookmarkRows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          id: `eq.${bookmarkId}`,
          user_id: `eq.${this.session.user.id}`,
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );
    const remoteBookmark = bookmarkRows[0];
    if (!remoteBookmark) {
      return null;
    }

    const [tags, collection, enrichment] = await Promise.all([
      this.listTagsForBookmark(bookmarkId),
      remoteBookmark.collection_id ? this.getCollection(remoteBookmark.collection_id) : null,
      this.getLatestEnrichment(bookmarkId),
    ]);

    return {
      bookmark: remoteToBookmark(remoteBookmark),
      tags,
      collection,
      enrichment,
    };
  }

  async updateBookmark(
    bookmarkId: string,
    input: UpdateBookmarkInput & { last_saved_at?: string },
  ): Promise<Bookmark> {
    const rows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          id: `eq.${bookmarkId}`,
          user_id: `eq.${this.session.user.id}`,
        }),
      ),
      {
        method: 'PATCH',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: {
          ...input,
          updated_at: nowIso(),
        },
      },
    );

    const updated = rows[0];
    if (!updated) {
      throw new Error('Bookmark not found or not owned by the current user.');
    }

    return remoteToBookmark(updated);
  }

  async deleteBookmark(bookmarkId: string, permanent = false): Promise<void> {
    if (!permanent) {
      await this.updateBookmark(bookmarkId, { is_archived: true });
      return;
    }

    await this.client.request(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          id: `eq.${bookmarkId}`,
          user_id: `eq.${this.session.user.id}`,
        }),
      ),
      {
        method: 'DELETE',
        accessToken: this.session.access_token,
      },
    );
  }

  async addTags(input: AddTagsInput): Promise<Tag[]> {
    const tags = uniqueNormalizedTags(input.tags);
    const ensuredTags = await Promise.all(
      tags.map((tag) => this.ensureTag(tag.name, tag.slug, input.source)),
    );
    const timestamp = nowIso();

    if (ensuredTags.length > 0) {
      await this.client.request('/rest/v1/bookmark_tags', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: ensuredTags.map((tag) => ({
          bookmark_id: input.bookmark_id,
          tag_id: tag.id,
          source: input.source,
          confidence: null,
          created_at: timestamp,
        })),
      });
    }

    return ensuredTags;
  }

  async removeTags(input: RemoveTagsInput): Promise<void> {
    const tags = uniqueNormalizedTags(input.tags);
    if (tags.length === 0) {
      return;
    }

    const existingTags = await this.findTagsBySlugs(tags.map((tag) => tag.slug));
    const tagIds = existingTags.map((tag) => tag.id);
    if (tagIds.length === 0) {
      return;
    }

    await this.client.request(
      appendSearchParams(
        '/rest/v1/bookmark_tags',
        new URLSearchParams({
          bookmark_id: `eq.${input.bookmark_id}`,
          tag_id: `in.${inFilter(tagIds)}`,
        }),
      ),
      { method: 'DELETE', accessToken: this.session.access_token },
    );
  }

  async updateAIEnrichment(input: UpdateAIEnrichmentInput): Promise<AIEnrichment> {
    const existing = await this.getLatestEnrichment(input.bookmark_id);
    const timestamp = nowIso();
    const body = {
      user_id: this.session.user.id,
      bookmark_id: input.bookmark_id,
      summary: input.summary ?? null,
      topics: input.topics ?? [],
      suggested_tags: input.suggested_tags ?? [],
      suggested_collection_id: input.suggested_collection_id ?? null,
      status: input.status,
      model: input.model ?? null,
      confidence: input.confidence ?? null,
      updated_at: timestamp,
    };

    if (!existing) {
      const rows = await this.client.request<RemoteAIEnrichment[]>('/rest/v1/ai_enrichments', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: { ...body, created_at: timestamp },
      });
      const created = rows[0];
      if (!created) {
        throw new Error('Supabase did not return the created AI enrichment.');
      }

      return enrichmentFromRemote(created);
    }

    const rows = await this.client.request<RemoteAIEnrichment[]>(
      appendSearchParams(
        '/rest/v1/ai_enrichments',
        new URLSearchParams({
          id: `eq.${existing.id}`,
          user_id: `eq.${this.session.user.id}`,
        }),
      ),
      {
        method: 'PATCH',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body,
      },
    );
    const updated = rows[0];
    if (!updated) {
      throw new Error('AI enrichment not found or not owned by the current user.');
    }

    return enrichmentFromRemote(updated);
  }

  /**
   * Ask the backend `ai-enrich` edge function to (re)generate suggestions for a
   * bookmark. The function writes the `ai_enrichments` row and returns it, so
   * the caller can surface results without waiting for the next pull sync.
   *
   * `metadata` carries the device's freshest content fields. The cloud row can
   * lag behind on-device OpenGraph enrichment (a just-captured bookmark is often
   * still a bare URL server-side), so passing them lets the model reason about
   * the real title/site instead of an empty row and return useful suggestions.
   *
   * `locale` is the user's active language (e.g. 'ko'), so the model writes the
   * summary and tags in their language (M12). Optional — the server defaults to
   * English.
   */
  async requestEnrichment(
    bookmarkId: string,
    metadata?: EnrichmentMetadataHint,
    locale?: string,
  ): Promise<AIEnrichment> {
    const row = await this.client.request<RemoteAIEnrichment>('/functions/v1/ai-enrich', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: {
        bookmark_id: bookmarkId,
        ...(metadata ? { metadata } : {}),
        ...(locale ? { locale } : {}),
      },
    });
    return enrichmentFromRemote(row);
  }

  async applyAISuggestions(input: ApplyAISuggestionsInput): Promise<BookmarkDetail | null> {
    if (input.tag_names && input.tag_names.length > 0) {
      await this.addTags({
        bookmark_id: input.bookmark_id,
        tags: input.tag_names,
        source: 'user',
      });
    }

    if (input.collection_id !== undefined) {
      await this.updateBookmark(input.bookmark_id, { collection_id: input.collection_id });
    }

    return this.getBookmark(input.bookmark_id);
  }

  private async findActiveBookmarkByUrlHash(urlHash: string): Promise<RemoteBookmark | null> {
    const rows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          url_hash: `eq.${urlHash}`,
          is_archived: 'eq.false',
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );

    return rows[0] ?? null;
  }

  /**
   * Looks up a row by its device-generated capture id. Unlike the URL lookup
   * this is NOT filtered to active rows: client_id is globally unique per user,
   * so a retried create must resolve to its original row even if it was archived
   * in between — re-inserting would violate the unique index anyway.
   */
  private async findBookmarkByClientId(clientId: string): Promise<RemoteBookmark | null> {
    const rows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          client_id: `eq.${clientId}`,
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );

    return rows[0] ?? null;
  }

  private baseBookmarkListParams(params: ListBookmarksParams): URLSearchParams {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const query = new URLSearchParams({
      select: '*',
      user_id: `eq.${this.session.user.id}`,
      order: sortParam(params.sort),
      limit: String(limit),
    });

    if (params.is_archived !== undefined) {
      query.set('is_archived', `eq.${params.is_archived ? 'true' : 'false'}`);
    }
    if (params.collection_id !== undefined) {
      query.set('collection_id', params.collection_id === null ? 'is.null' : `eq.${params.collection_id}`);
    }
    if (params.cursor) {
      const cursorOperator = sortParam(params.sort).endsWith('.asc') ? 'gt' : 'lt';
      const cursorColumn = sortParam(params.sort).startsWith('updated_at') ? 'updated_at' : 'created_at';
      query.set(cursorColumn, `${cursorOperator}.${params.cursor}`);
    }
    if (params.query?.trim()) {
      // Strip characters with meaning inside a PostgREST or=() expression so
      // user input cannot corrupt the filter.
      const term = params.query.trim().replace(/[%*,()]/g, '');
      query.set('or', `(title.ilike.*${term}*,description.ilike.*${term}*,notes.ilike.*${term}*,url.ilike.*${term}*)`);
    }

    return query;
  }

  private async listBookmarksByTags(params: ListBookmarksParams): Promise<Bookmark[]> {
    const tagIds = params.tag_ids ?? [];
    const bookmarkTagRows = await this.client.request<Array<Pick<BookmarkTag, 'bookmark_id'>>>(
      appendSearchParams(
        '/rest/v1/bookmark_tags',
        new URLSearchParams({
          select: 'bookmark_id',
          tag_id: `in.${inFilter(tagIds)}`,
        }),
      ),
      { accessToken: this.session.access_token },
    );
    const bookmarkIds = [...new Set(bookmarkTagRows.map((row) => row.bookmark_id))];
    if (bookmarkIds.length === 0) {
      return [];
    }

    const query = this.baseBookmarkListParams(params);
    query.set('id', `in.${inFilter(bookmarkIds)}`);
    const rows = await this.client.request<RemoteBookmark[]>(
      appendSearchParams('/rest/v1/bookmarks', query),
      { accessToken: this.session.access_token },
    );

    return rows.map(remoteToBookmark);
  }

  private async getCollection(collectionId: string): Promise<Collection | null> {
    const rows = await this.client.request<Collection[]>(
      appendSearchParams(
        '/rest/v1/collections',
        new URLSearchParams({
          select: '*',
          id: `eq.${collectionId}`,
          user_id: `eq.${this.session.user.id}`,
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );

    return rows[0] ?? null;
  }

  private async listTagsForBookmark(bookmarkId: string): Promise<Tag[]> {
    const links = await this.client.request<Array<Pick<BookmarkTag, 'tag_id'>>>(
      appendSearchParams(
        '/rest/v1/bookmark_tags',
        new URLSearchParams({
          select: 'tag_id',
          bookmark_id: `eq.${bookmarkId}`,
        }),
      ),
      { accessToken: this.session.access_token },
    );
    const tagIds = links.map((link) => link.tag_id);
    if (tagIds.length === 0) {
      return [];
    }

    return this.client.request<Tag[]>(
      appendSearchParams(
        '/rest/v1/tags',
        new URLSearchParams({
          select: '*',
          id: `in.${inFilter(tagIds)}`,
          user_id: `eq.${this.session.user.id}`,
          order: 'name.asc',
        }),
      ),
      { accessToken: this.session.access_token },
    );
  }

  private async getLatestEnrichment(bookmarkId: string): Promise<AIEnrichment | null> {
    const rows = await this.client.request<RemoteAIEnrichment[]>(
      appendSearchParams(
        '/rest/v1/ai_enrichments',
        new URLSearchParams({
          select: '*',
          bookmark_id: `eq.${bookmarkId}`,
          user_id: `eq.${this.session.user.id}`,
          order: 'created_at.desc',
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );

    return rows[0] ? enrichmentFromRemote(rows[0]) : null;
  }

  private async ensureTag(name: string, slug: string, source: TagSource): Promise<Tag> {
    const existing = await this.findTagsBySlugs([slug]);
    if (existing[0]) {
      return existing[0];
    }

    let rows: Tag[];
    try {
      rows = await this.client.request<Tag[]>('/rest/v1/tags', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: {
          user_id: this.session.user.id,
          name,
          slug,
          source,
          created_at: nowIso(),
        },
      });
    } catch (error) {
      if (error instanceof SupabaseRequestError && error.status === 409) {
        const raced = await this.findTagsBySlugs([slug]);
        if (raced[0]) {
          return raced[0];
        }
      }
      throw error;
    }
    const created = rows[0];
    if (!created) {
      throw new Error('Supabase did not return the created tag.');
    }

    return created;
  }

  private async findTagsBySlugs(slugs: string[]): Promise<Tag[]> {
    if (slugs.length === 0) {
      return [];
    }

    return this.client.request<Tag[]>(
      appendSearchParams(
        '/rest/v1/tags',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          slug: `in.${inFilter(slugs)}`,
        }),
      ),
      { accessToken: this.session.access_token },
    );
  }
}

export function createBookmarkApi(session: SupabaseAuthSession): BookmarkApi {
  return new BookmarkApi(session);
}
