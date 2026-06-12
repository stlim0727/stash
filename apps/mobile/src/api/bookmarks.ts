import { normalizeUrl } from '@/domain/urls';
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

export type RemoteBookmark = Omit<Bookmark, 'sync_status'>;

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

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function slugify(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

    if (payload.url) {
      const existing = await this.findActiveBookmarkByUrlHash(payload.url);
      if (existing) {
        await this.updateBookmark(existing.id, { last_saved_at: timestamp });
        return {
          bookmark_id: existing.id,
          status: 'duplicate',
          metadata_status: existing.metadata_status,
        };
      }
    }

    const createBody = {
      user_id: this.session.user.id,
      url: payload.url,
      canonical_url: null,
      url_hash: payload.url,
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
      // If another client created the same active URL between our lookup and
      // insert, treat the unique-index conflict as the documented duplicate
      // save behavior.
      if (payload.url && error instanceof SupabaseRequestError && error.status === 409) {
        const duplicate = await this.findActiveBookmarkByUrlHash(payload.url);
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
