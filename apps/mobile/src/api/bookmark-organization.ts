import { appendSearchParams, inFilter, nowIso, uniqueNormalizedTags } from '@/api/bookmark-helpers';
import { type AddTagsInput, type BulkAttachItem, type BulkAttachResult, type RemoveTagsInput } from '@/api/bookmark-types';
import { normalizeText, slugify } from '@/domain/tag-normalize';
import type {
  BookmarkTag,
  Collection,
  Tag,
  TagSource
} from '@/domain/types';
import type { RequestOptions, StashSupabaseClient } from '@/supabase/client';
import { SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

interface ListTagsDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listTags(this: ListTagsDependencies, beforePage?: () => void): Promise<Tag[]> {
  return this.fetchAllPages<Tag>('/rest/v1/tags', (query) => {
    query.set('order', 'name.asc,id.asc');
  }, beforePage);
}

interface ListBookmarkTagsDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listBookmarkTags(this: ListBookmarkTagsDependencies, beforePage?: () => void): Promise<BookmarkTag[]> {
  return this.fetchAllPages<BookmarkTag>('/rest/v1/bookmark_tags', (query) => {
    // bookmark_tags has no user_id column; RLS scopes rows to the owner.
    query.delete('user_id');
    query.set('order', 'bookmark_id.asc,tag_id.asc');
  }, beforePage);
}

interface ListCollectionsDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listCollections(this: ListCollectionsDependencies, beforePage?: () => void): Promise<Collection[]> {
  return this.fetchAllPages<Collection>('/rest/v1/collections', (query) => {
    query.set('order', 'name.asc,id.asc');
  }, beforePage);
}

interface CreateCollectionDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function createCollection(this: CreateCollectionDependencies, name: string, description?: string): Promise<Collection> {
  const timestamp = nowIso();
  const rows = await this.requestArray<Collection>('/rest/v1/collections', {
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

interface UpdateCollectionDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function updateCollection(this: UpdateCollectionDependencies,
  collectionId: string,
  updates: { name?: string; description?: string | null },
): Promise<Collection> {
  const timestamp = nowIso();
  const body: Record<string, unknown> = {
    updated_at: timestamp,
  };
  if (updates.name !== undefined) {
    body.name = normalizeText(updates.name);
  }
  if (updates.description !== undefined) {
    body.description = updates.description?.trim() || null;
  }
  const rows = await this.requestArray<Collection>(
    appendSearchParams(
      '/rest/v1/collections',
      new URLSearchParams({
        id: `eq.${collectionId}`,
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
    throw new Error('Supabase did not return the updated collection.');
  }
  return updated;
}

interface DeleteCollectionDependencies {
  deleteCollections: (collectionIds: string[], action?: "uncategorize" | "trash") => Promise<void>;
}

export async function deleteCollection(this: DeleteCollectionDependencies,
  collectionId: string,
  action: 'uncategorize' | 'trash' = 'uncategorize',
): Promise<void> {
  return this.deleteCollections([collectionId], action);
}

interface DeleteCollectionsDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function deleteCollections(this: DeleteCollectionsDependencies,
  collectionIds: string[],
  action: 'uncategorize' | 'trash' = 'uncategorize',
): Promise<void> {
  if (collectionIds.length === 0) {
    return;
  }
  await this.client.request('/rest/v1/rpc/delete_user_collections', {
    method: 'POST',
    accessToken: this.session.access_token,
    body: {
      collection_ids: collectionIds,
      delete_action: action,
    },
  });
}

interface MergeCollectionsDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function mergeCollections(this: MergeCollectionsDependencies,
  sourceCollectionIds: string[],
  targetCollectionId: string,
): Promise<void> {
  const sources = sourceCollectionIds.filter((id) => id !== targetCollectionId);
  if (sources.length === 0) {
    return;
  }
  await this.client.request('/rest/v1/rpc/merge_user_collections', {
    method: 'POST',
    accessToken: this.session.access_token,
    body: {
      source_collection_ids: sources,
      target_collection_id: targetCollectionId,
    },
  });
}

interface AddTagsDependencies {
  ensureTag: (name: string, slug: string, source: TagSource) => Promise<Tag>;
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function addTags(this: AddTagsDependencies, input: AddTagsInput): Promise<Tag[]> {
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

interface BulkAttachTagsAndCollectionsDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function bulkAttachTagsAndCollections(this: BulkAttachTagsAndCollectionsDependencies, items: BulkAttachItem[]): Promise<BulkAttachResult[]> {
  if (items.length === 0) {
    return [];
  }

  const payload = items.map((item) => {
    const normalizedTags = uniqueNormalizedTags(item.tags.map((tag) => tag.name));
    // uniqueNormalizedTags dedupes/normalizes name+slug but drops the
    // per-tag `source`; resolve it back by slug (ops are already deduped
    // per (bookmark, tag slug) by enqueueTagOp, so this is 1:1 in practice).
    const sourceBySlug = new Map(
      item.tags.map((tag) => [slugify(normalizeText(tag.name)), tag.source] as const),
    );
    return {
      bookmark_id: item.bookmark_id,
      tags: normalizedTags.map((tag) => ({
        name: tag.name,
        slug: tag.slug,
        source: sourceBySlug.get(tag.slug) ?? ('user' as TagSource),
      })),
      collection_name: item.collection_name,
    };
  });

  return this.requestArray<BulkAttachResult>(
    '/rest/v1/rpc/bulk_attach_bookmark_tags_and_collections',
    {
      method: 'POST',
      accessToken: this.session.access_token,
      body: { items: payload },
    },
  );
}

interface RemoveTagsDependencies {
  findTagsBySlugs: (slugs: string[]) => Promise<Tag[]>;
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function removeTags(this: RemoveTagsDependencies, input: RemoveTagsInput): Promise<void> {
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

interface GetCollectionDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function getCollection(this: GetCollectionDependencies, collectionId: string): Promise<Collection | null> {
  const rows = await this.requestArray<Collection>(
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

interface ListTagsForBookmarkDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function listTagsForBookmark(this: ListTagsForBookmarkDependencies, bookmarkId: string): Promise<Tag[]> {
  const links = await this.requestArray<Pick<BookmarkTag, 'tag_id'>>(
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

  return this.requestArray<Tag>(
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

interface EnsureTagDependencies {
  findTagsBySlugs: (slugs: string[]) => Promise<Tag[]>;
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function ensureTag(this: EnsureTagDependencies, name: string, slug: string, source: TagSource): Promise<Tag> {
  const existing = await this.findTagsBySlugs([slug]);
  if (existing[0]) {
    return existing[0];
  }

  let rows: Tag[];
  try {
    rows = await this.requestArray<Tag>('/rest/v1/tags', {
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

interface FindTagsBySlugsDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findTagsBySlugs(this: FindTagsBySlugsDependencies, slugs: string[]): Promise<Tag[]> {
  if (slugs.length === 0) {
    return [];
  }

  return this.requestArray<Tag>(
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
