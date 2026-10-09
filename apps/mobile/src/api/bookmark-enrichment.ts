import { AI_ENRICH_REQUEST_TIMEOUT_MS, appendSearchParams, enrichmentFromRemote, inFilter, nowIso } from '@/api/bookmark-helpers';
import { type AddTagsInput, type ApplyAISuggestionsInput, type BookmarkDetail, type EnrichmentMetadataHint, type RemoteAIEnrichment, type UpdateAIEnrichmentInput, type UpdateBookmarkInput } from '@/api/bookmark-types';
import type { AiServerQueueSnapshot } from '@/domain/processing-status';
import type {
  AIEnrichment,
  Bookmark,
  Tag
} from '@/domain/types';
import type { RequestOptions, StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

interface ListEnrichmentsUpdatedSinceDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function listEnrichmentsUpdatedSince(this: ListEnrichmentsUpdatedSinceDependencies,
  since: string | null,
  beforePage?: () => void,
): Promise<AIEnrichment[]> {
  const rows = await this.fetchAllPages<RemoteAIEnrichment>('/rest/v1/ai_enrichments', (query) => {
    query.set('order', 'updated_at.asc,id.asc');
    if (since) {
      query.set('updated_at', `gt.${since}`);
    }
  }, beforePage);
  return rows.map(enrichmentFromRemote);
}

interface UpdateAIEnrichmentDependencies {
  getLatestEnrichment: (bookmarkId: string) => Promise<AIEnrichment | null>;
  session: SupabaseAuthSession;
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
}

export async function updateAIEnrichment(this: UpdateAIEnrichmentDependencies, input: UpdateAIEnrichmentInput): Promise<AIEnrichment> {
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
    const rows = await this.requestArray<RemoteAIEnrichment>('/rest/v1/ai_enrichments', {
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

  const rows = await this.requestArray<RemoteAIEnrichment>(
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

interface RestoreAIEnrichmentDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function restoreAIEnrichment(this: RestoreAIEnrichmentDependencies, input: UpdateAIEnrichmentInput): Promise<AIEnrichment | null> {
  const timestamp = nowIso();
  const rows = await this.requestArray<RemoteAIEnrichment>(
    '/rest/v1/ai_enrichments?on_conflict=bookmark_id',
    {
      method: 'POST',
      accessToken: this.session.access_token,
      headers: { Prefer: 'resolution=ignore-duplicates, return=representation' },
      body: {
        user_id: this.session.user.id,
        bookmark_id: input.bookmark_id,
        summary: input.summary ?? null,
        topics: input.topics ?? [],
        suggested_tags: input.suggested_tags ?? [],
        suggested_collection_id: input.suggested_collection_id ?? null,
        status: input.status,
        model: input.model ?? null,
        confidence: input.confidence ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    },
  );
  const created = rows[0];
  return created ? enrichmentFromRemote(created) : null;
}

interface BulkRestoreAIEnrichmentDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function bulkRestoreAIEnrichment(this: BulkRestoreAIEnrichmentDependencies, inputs: UpdateAIEnrichmentInput[]): Promise<AIEnrichment[]> {
  if (inputs.length === 0) {
    return [];
  }
  const timestamp = nowIso();
  const rows = await this.requestArray<RemoteAIEnrichment>(
    '/rest/v1/ai_enrichments?on_conflict=bookmark_id',
    {
      method: 'POST',
      accessToken: this.session.access_token,
      headers: { Prefer: 'resolution=ignore-duplicates, return=representation' },
      body: inputs.map((input) => ({
        user_id: this.session.user.id,
        bookmark_id: input.bookmark_id,
        summary: input.summary ?? null,
        topics: input.topics ?? [],
        suggested_tags: input.suggested_tags ?? [],
        suggested_collection_id: input.suggested_collection_id ?? null,
        status: input.status,
        model: input.model ?? null,
        confidence: input.confidence ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      })),
    },
  );
  return rows.map(enrichmentFromRemote);
}

interface RequestEnrichmentDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function requestEnrichment(this: RequestEnrichmentDependencies,
  bookmarkId: string,
  metadata?: EnrichmentMetadataHint,
  locale?: string,
): Promise<AIEnrichment> {
  const row = await this.client.request<RemoteAIEnrichment>('/functions/v1/ai-enrich', {
    method: 'POST',
    accessToken: this.session.access_token,
    timeoutMs: AI_ENRICH_REQUEST_TIMEOUT_MS,
    body: {
      bookmark_id: bookmarkId,
      ...(metadata ? { metadata } : {}),
      ...(locale ? { locale } : {}),
    },
  });
  return enrichmentFromRemote(row);
}

interface EnqueuePendingEnrichmentDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function enqueuePendingEnrichment(this: EnqueuePendingEnrichmentDependencies, bookmarkId: string, locale?: string): Promise<void> {
  await this.client.request('/rest/v1/pending_ai_enrichment?on_conflict=bookmark_id', {
    method: 'POST',
    accessToken: this.session.access_token,
    headers: { Prefer: 'resolution=ignore-duplicates, return=minimal' },
    body: {
      bookmark_id: bookmarkId,
      user_id: this.session.user.id,
      ...(locale ? { locale } : {}),
    },
  });
}

interface FetchPendingEnrichmentStatusesDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function fetchPendingEnrichmentStatuses(this: FetchPendingEnrichmentStatusesDependencies,
  bookmarkIds: string[],
): Promise<Array<{ bookmark_id: string; status: string }>> {
  if (bookmarkIds.length === 0) {
    return [];
  }
  return this.requestArray<{ bookmark_id: string; status: string }>(
    appendSearchParams(
      '/rest/v1/pending_ai_enrichment',
      new URLSearchParams({
        select: 'bookmark_id,status',
        bookmark_id: `in.${inFilter(bookmarkIds)}`,
      }),
    ),
    { accessToken: this.session.access_token },
  );
}

interface FetchAiQueueSnapshotDependencies {
  fetchAllPages: <T>(path: string, configure: (query: URLSearchParams) => void, beforePage?: () => void) => Promise<T[]>;
}

export async function fetchAiQueueSnapshot(this: FetchAiQueueSnapshotDependencies): Promise<AiServerQueueSnapshot[]> {
  return this.fetchAllPages<AiServerQueueSnapshot>(
    '/rest/v1/pending_ai_enrichment',
    (query) => {
      query.set('select', 'bookmark_id,status,attempts,created_at,updated_at');
      query.set('status', 'in.(pending,processing,failed)');
      query.set('order', 'created_at.asc,bookmark_id.asc');
    },
  );
}

interface ApplyAISuggestionsDependencies {
  addTags: (input: AddTagsInput) => Promise<Tag[]>;
  updateBookmark: (bookmarkId: string, input: UpdateBookmarkInput & { last_saved_at?: string; }) => Promise<Bookmark>;
  getBookmark: (bookmarkId: string) => Promise<BookmarkDetail | null>;
}

export async function applyAISuggestions(this: ApplyAISuggestionsDependencies, input: ApplyAISuggestionsInput): Promise<BookmarkDetail | null> {
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

interface GetLatestEnrichmentDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function getLatestEnrichment(this: GetLatestEnrichmentDependencies, bookmarkId: string): Promise<AIEnrichment | null> {
  const rows = await this.requestArray<RemoteAIEnrichment>(
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
