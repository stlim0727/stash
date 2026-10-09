import { appendSearchParams, DEFAULT_PAGE_SIZE, inFilter, MAX_PAGE_SIZE, remoteToBookmark, sortParam } from '@/api/bookmark-helpers';
import { type BookmarkDetail, type ListBookmarksParams, type RemoteBookmark } from '@/api/bookmark-types';
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  Tag
} from '@/domain/types';
import type { RequestOptions } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

interface ListBookmarksDependencies {
  listBookmarksByTags: (params: ListBookmarksParams) => Promise<Bookmark[]>;
  baseBookmarkListParams: (params: ListBookmarksParams) => URLSearchParams;
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function listBookmarks(this: ListBookmarksDependencies, params: ListBookmarksParams = {}): Promise<Bookmark[]> {
  if (params.tag_ids && params.tag_ids.length > 0) {
    return this.listBookmarksByTags(params);
  }

  const query = this.baseBookmarkListParams(params);
  const rows = await this.requestArray<RemoteBookmark>(
    appendSearchParams('/rest/v1/bookmarks', query),
    { accessToken: this.session.access_token },
  );

  return rows.map(remoteToBookmark);
}

interface ListBookmarksUpdatedSinceDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listBookmarksUpdatedSince(this: ListBookmarksUpdatedSinceDependencies,
  since: string | null,
  beforePage?: () => void,
): Promise<Bookmark[]> {
  const rows = await this.fetchAllPages<RemoteBookmark>('/rest/v1/bookmarks', (query) => {
    query.set('order', 'updated_at.asc,id.asc');
    if (since) {
      query.set('updated_at', `gt.${since}`);
    }
  }, beforePage);
  return rows.map(remoteToBookmark);
}

interface ListBookmarkIdsDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listBookmarkIds(this: ListBookmarkIdsDependencies, beforePage?: () => void): Promise<string[]> {
  const rows = await this.fetchAllPages<{ id: string }>('/rest/v1/bookmarks', (query) => {
    query.set('select', 'id');
    query.set('order', 'id.asc');
  }, beforePage);
  return rows.map((row) => row.id);
}

interface GetBookmarkDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
  listTagsForBookmark: (bookmarkId: string) => Promise<Tag[]>;
  getCollection: (collectionId: string) => Promise<Collection | null>;
  getLatestEnrichment: (bookmarkId: string) => Promise<AIEnrichment | null>;
}

export async function getBookmark(this: GetBookmarkDependencies, bookmarkId: string): Promise<BookmarkDetail | null> {
  const bookmarkRows = await this.requestArray<RemoteBookmark>(
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

interface BaseBookmarkListParamsDependencies {
  session: SupabaseAuthSession;
}

export function baseBookmarkListParams(this: BaseBookmarkListParamsDependencies, params: ListBookmarksParams): URLSearchParams {
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

interface ListBookmarksByTagsDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
  baseBookmarkListParams: (params: ListBookmarksParams) => URLSearchParams;
}

export async function listBookmarksByTags(this: ListBookmarksByTagsDependencies, params: ListBookmarksParams): Promise<Bookmark[]> {
  const tagIds = params.tag_ids ?? [];
  const bookmarkTagRows = await this.requestArray<Pick<BookmarkTag, 'bookmark_id'>>(
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
  const rows = await this.requestArray<RemoteBookmark>(
    appendSearchParams('/rest/v1/bookmarks', query),
    { accessToken: this.session.access_token },
  );

  return rows.map(remoteToBookmark);
}
