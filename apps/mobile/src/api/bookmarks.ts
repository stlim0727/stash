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
  TextFormat,
} from '@/domain/types';
import type { AiServerQueueSnapshot } from '@/domain/processing-status';
import { createSupabaseClient, SupabaseRequestError } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

// `local_image_uri` is a device-only field (a captured image's on-disk URI),
// `local_image_mime_type` is the device-only MIME type recorded alongside it,
// `last_accessed_at` is a device-only "last opened" timestamp,
// `title_is_derived` is device-only title provenance, and `video_unavailable`
// is a device-only, self-healing YouTube-availability check result (STASH-61),
// so none is ever part of a remote row, alongside the local-only `sync_status`.
export type RemoteBookmark = Omit<
  Bookmark,
  | 'sync_status'
  | 'local_image_uri'
  | 'local_image_mime_type'
  | 'last_accessed_at'
  | 'title_is_derived'
  | 'video_unavailable'
>;

// Thrown by `updateBookmark` when the PATCH (scoped to `id` + the current
// user's `user_id`) matches zero rows — the bookmark was deleted (on this
// device or another) or never belonged to this user. Exported so sync can
// recognize this exact, unambiguous case and reconcile instead of retrying
// an edit that can never land (see `sync/sync-bookmarks.ts`).
export const BOOKMARK_NOT_FOUND_ERROR_MESSAGE = 'Bookmark not found or not owned by the current user.';

export interface CreateBookmarkOutput {
  bookmark_id: string;
  status: 'created' | 'duplicate' | 'queued';
  metadata_status: MetadataStatus;
}

export interface BulkCreateBookmarkOutput extends CreateBookmarkOutput {
  client_id?: string | null;
  url_hash?: string | null;
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
  description_format?: TextFormat | null;
  notes_format?: TextFormat | null;
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
  dismissed_suggested_tags?: string[] | null;
  dismissed_suggested_folders?: string[] | null;
  reviewed_summary_tokens?: string[] | null;
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

/**
 * One bookmark's worth of work for `bulkAttachTagsAndCollections` (issue
 * #713): the bookmark must already exist server-side (bulk-created
 * separately). `tags` names are raw/unnormalized — the method normalizes and
 * dedupes them via `uniqueNormalizedTags` before sending. `collection_name`
 * mirrors `syncPendingImportCollections`'s single-collection-per-bookmark
 * import model; pass `null` to attach tags only.
 */
export interface BulkAttachItem {
  bookmark_id: string;
  tags: Array<{ name: string; source: TagSource }>;
  collection_name: string | null;
}

/**
 * Per-bookmark result of `bulkAttachTagsAndCollections`. `collection` is the
 * resolved-or-created collection row whenever `collection_name` was sent, even
 * if `collection_attached` is false (the bookmark already had a different
 * collection — see the RPC's `collection_id is null` guard) — callers still
 * need it to keep their local collections cache complete. `bookmark_updated_at`
 * is set only when the collection was actually attached (the RPC bumps it then,
 * matching what a normal collection-assigning PATCH does).
 */
export interface BulkAttachResult {
  bookmark_id: string;
  tags: Tag[];
  collection: Collection | null;
  collection_attached: boolean;
  bookmark_updated_at: string | null;
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

  // A restored text memo can legitimately have no body while retaining a
  // title, notes, tags, or collection. Its explicit type is enough to create
  // the row; manual Add still validates that newly-authored memos have a body.
  if (input.content_type === 'text') {
    return { url: null, contentType: 'text' };
  }

  // Image-only capture (a screenshot with no link): the client always
  // uploads the binary to Storage and resolves its public URL BEFORE calling
  // createBookmark, so this branch only ever sees an already-uploaded row —
  // requiring preview_image_url here (rather than trusting content_type
  // alone) is what stops a bookmark from ever being created server-side
  // before its image binary has genuinely landed (STASH-65 invariant).
  if (input.content_type === 'image' && input.preview_image_url?.trim()) {
    return { url: null, contentType: 'image' };
  }

  throw new Error('createBookmark requires either url, shared_text, or an uploaded image.');
}

function remoteToBookmark(row: RemoteBookmark): Bookmark {
  return { ...row, sync_status: 'synced', ever_synced: true };
}

// Validate emptiness with a trimmed copy, but keep the original value —
// leading/trailing whitespace can be meaningful Markdown (e.g. an indented
// code block), so a memo body must not be silently rewritten on upload.
function descriptionFromInput(input: {
  description?: string | null;
  shared_text?: string;
}): string | null {
  if (input.description?.trim()) {
    return input.description;
  }
  if (input.shared_text?.trim()) {
    return input.shared_text;
  }
  return null;
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
  // Escape backslashes first, then quotes — otherwise a trailing `\` combines
  // with our injected `\"` and lets the value break out of its own quote.
  return `(${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')})`;
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

function bulkCreateKey(item: { urlHash: string | null; clientId: string | null }): string | null {
  if (item.urlHash) {
    return `url:${item.urlHash}`;
  }
  if (item.clientId) {
    return `client:${item.clientId}`;
  }
  return null;
}

export class BookmarkApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) {}

  /**
   * Wraps `client.request` for PostgREST endpoints that always answer with a
   * row array on success. A 2xx response can still arrive with an empty body
   * (a truncated response on a flaky connection, a dropped `Prefer:
   * return=representation`) — `request` parses that as `null`, not `[]`
   * (STASH-4Z: this crashed `createBookmarks` with "Cannot read property
   * 'filter' of null" instead of failing the sync entry cleanly). A real
   * zero-row PostgREST result is the literal JSON `[]`, never an empty body,
   * so `null` here always means "we don't actually know what came back" —
   * treating it as `[]` would be reading a truncated response as a confirmed
   * empty one. That's silently wrong for the pull's list/pagination calls in
   * particular: `listBookmarkIds` feeds the remote-deletion diff in
   * `sync/pull-bookmarks.ts`, so a page that came back short would read as
   * "these bookmarks no longer exist remotely" and delete them locally
   * (caught in PR review — Codex). Throw instead: every caller already sits
   * inside a catch-and-retry boundary (the sync entry's failEntry path, or
   * pullRemoteChanges's outer try/catch, which persists nothing until every
   * parallel fetch has resolved), so failing loud here just fails that one
   * attempt cleanly instead of crashing on an unrelated array method or
   * corrupting local state with a partial snapshot.
   */
  private async requestArray<T>(
    ...args: Parameters<StashSupabaseClient['request']>
  ): Promise<T[]> {
    const payload = await this.client.request<T[]>(...args);
    if (!Array.isArray(payload)) {
      throw new Error(`Supabase returned a non-array response from ${args[0]}.`);
    }
    return payload;
  }

  /**
   * This instance's own signed-in user id — the same id `imageUploadTarget`
   * namespaces its Storage path by. Exposed so `sync/sync-bookmarks.ts` can
   * verify an already-uploaded image actually belongs to the CURRENT session
   * before trusting it on a retry (see `Bookmark.local_image_uploaded_for_user_id`).
   */
  get userId(): string {
    return this.session.user.id;
  }

  /**
   * Computes where an image-only bookmark's binary should be uploaded: the
   * `bookmark-images` Storage bucket, at a path namespaced by this session's
   * own user id so the bucket's owner-scoped write policies accept it. Pure —
   * makes no network call itself. The caller (a native-only file upload, see
   * `storage/image-store.native.ts`) PUTs the file to `uploadUrl` with
   * `headers`, then passes `publicUrl` to `createBookmark` as
   * `preview_image_url` once the upload actually succeeds. Never call this
   * before the binary is about to be uploaded — the returned `publicUrl` is
   * only real once the object exists at that path.
   */
  imageUploadTarget(
    bookmarkId: string,
    contentType: string,
  ): { uploadUrl: string; publicUrl: string; headers: Record<string, string> } {
    const path = `${this.session.user.id}/${bookmarkId}`;
    return this.client.storageUploadTarget('bookmark-images', path, {
      accessToken: this.session.access_token,
      contentType,
    });
  }

  /**
   * Deletes the uploaded `bookmark-images` objects for the given bookmark
   * ids, scoped to this session's own user id (matches the path
   * `imageUploadTarget` uploads to). Best-effort by design — see
   * `StashSupabaseClient.removeStorageObjects`. Only meaningful for
   * bookmarks that actually uploaded (deleting a path with no object at it
   * is a harmless no-op), but callers don't need to filter for that.
   */
  async deleteImages(bookmarkIds: string[]): Promise<void> {
    const paths = bookmarkIds.map((id) => `${this.session.user.id}/${id}`);
    await this.client.removeStorageObjects('bookmark-images', paths, this.session.access_token);
  }

  async createBookmark(input: CreateBookmarkInput): Promise<CreateBookmarkOutput> {
    const payload = requirePayload(input);
    const timestamp = nowIso();
    const title = input.title?.trim() || null;
    const description = descriptionFromInput(input);
    const notes = input.notes?.length ? input.notes : null;
    const sourceApp = input.source_app?.trim() || null;
    const siteName = input.site_name?.trim() || null;
    const faviconUrl = input.favicon_url?.trim() || null;
    const previewImageUrl = input.preview_image_url?.trim() || null;
    const metadataStatus = input.metadata_status ?? 'pending';
    const enrichmentPolicy = input.enrichment_policy ?? 'auto';

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
    const existingByUrl = urlHash ? await this.findActiveBookmarkByUrlHash(urlHash) : null;
    const existing = existingByUrl ?? (clientId ? await this.findBookmarkByClientId(clientId) : null);
    if (existing) {
      // A retried create can land here after its FIRST attempt already
      // succeeded server-side (only the response was lost) — but this
      // request may carry a freshly-edited body (createUploadPayload
      // refreshes shared_text/description from the latest local state
      // before every upload attempt, including a retry). Push it through
      // instead of silently discarding it along with `last_saved_at`, or an
      // edit made between the original create and this idempotent retry is
      // lost — the cloud keeps the stale text forever.
      //
      // Only do this when `client_id` proves `existing` is THIS device's
      // own earlier attempt, not a urlHash match — a urlHash match can be a
      // genuinely different save (e.g. another device saved the same URL
      // since the last pull), and patching its description with this
      // request's payload would corrupt an unrelated row.
      const isOwnRetry = clientId !== null && existing.client_id === clientId;
      await this.updateBookmark(existing.id, {
        ...(isOwnRetry ? {
          description: description ?? undefined,
          notes: input.notes === undefined ? undefined : notes,
          description_format: input.description_format,
          notes_format: input.notes_format,
        } : {}),
        last_saved_at: timestamp,
      });
      return {
        bookmark_id: existing.id,
        status: 'duplicate',
        metadata_status: existing.metadata_status,
      };
    }

    const createBody = {
      // The client's own permanent id for this bookmark (see CreateBookmarkInput.id).
      // Sent explicitly so Postgres uses it as the primary key instead of
      // generating a new one — the local row never has to adopt a different id.
      id: input.id,
      user_id: this.session.user.id,
      url: payload.url,
      canonical_url: null,
      url_hash: urlHash,
      client_id: clientId,
      title,
      description,
      description_format: input.description_format,
      notes_format: input.notes_format,
      notes,
      source_app: sourceApp,
      content_type: payload.contentType,
      preview_image_url: previewImageUrl,
      favicon_url: faviconUrl,
      site_name: siteName,
      collection_id: null,
      is_archived: false,
      created_at: input.created_at || timestamp,
      updated_at: timestamp,
      last_saved_at: timestamp,
      metadata_status: metadataStatus,
      enrichment_policy: enrichmentPolicy,
    };

    let rows: RemoteBookmark[];
    try {
      rows = await this.requestArray<RemoteBookmark>('/rest/v1/bookmarks', {
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
        const duplicateByUrl = urlHash ? await this.findActiveBookmarkByUrlHash(urlHash) : null;
        const duplicate =
          duplicateByUrl ?? (clientId ? await this.findBookmarkByClientId(clientId) : null);
        if (duplicate) {
          // Same idempotent-retry case as the pre-insert `existing` branch
          // above (see its comment) — the insert itself lost the race to
          // this request's own earlier attempt, so apply the same
          // client-id-proven refreshed description here too.
          const isOwnRetry = clientId !== null && duplicate.client_id === clientId;
          await this.updateBookmark(duplicate.id, {
            ...(isOwnRetry ? {
              description: description ?? undefined,
              notes: input.notes === undefined ? undefined : notes,
              description_format: input.description_format,
              notes_format: input.notes_format,
            } : {}),
            last_saved_at: timestamp,
          });
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

  async createBookmarks(inputs: CreateBookmarkInput[]): Promise<BulkCreateBookmarkOutput[]> {
    if (inputs.length === 0) {
      return [];
    }

    const timestamp = nowIso();
    const prepared = inputs.map((input) => {
      const payload = requirePayload(input);
      const title = input.title?.trim() || null;
      const description = descriptionFromInput(input);
      const notes = input.notes?.length ? input.notes : null;
      const sourceApp = input.source_app?.trim() || null;
      const siteName = input.site_name?.trim() || null;
      const faviconUrl = input.favicon_url?.trim() || null;
      const previewImageUrl = input.preview_image_url?.trim() || null;
      const metadataStatus = input.metadata_status ?? 'pending';
      const enrichmentPolicy = input.enrichment_policy ?? 'auto';
      const urlHash = payload.url ? canonicalizeUrl(payload.url) : null;
      const clientId = input.client_id ?? null;
      return {
        urlHash,
        clientId,
        body: {
          // See createBookmark's createBody: sent explicitly so Postgres uses
          // it as the primary key instead of generating a new one.
          id: input.id,
          user_id: this.session.user.id,
          url: payload.url,
          canonical_url: null,
          url_hash: urlHash,
          client_id: clientId,
          title,
          description,
          description_format: input.description_format,
          notes_format: input.notes_format,
          notes,
          source_app: sourceApp,
          content_type: payload.contentType,
          preview_image_url: previewImageUrl,
          favicon_url: faviconUrl,
          site_name: siteName,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: input.created_at || timestamp,
          updated_at: timestamp,
          last_saved_at: timestamp,
          metadata_status: metadataStatus,
          enrichment_policy: enrichmentPolicy,
        },
      };
    });

    const [existingByUrlHash, existingByClientId] = await Promise.all([
      this.findActiveBookmarksByUrlHashes(
        prepared.map((item) => item.urlHash).filter((value): value is string => value !== null),
      ),
      this.findBookmarksByClientIds(
        prepared.map((item) => item.clientId).filter((value): value is string => value !== null),
      ),
    ]);

    const outputs: Array<BulkCreateBookmarkOutput | null> = new Array(inputs.length).fill(null);
    const duplicateIds = new Set<string>();
    // A retried create in this batch can find its OWN earlier attempt
    // already landed (response lost) — same idempotent-duplicate case the
    // single-entry createBookmark handles. Track a refreshed description
    // per duplicate so it can be pushed individually below instead of
    // discarded along with the shared last_saved_at-only bump.
    const duplicateContentUpdates = new Map<string, UpdateBookmarkInput>();
    const pendingByKey = new Map<string, number>();
    const duplicateIndexesByInsertIndex = new Map<number, number[]>();
    const inserts: Array<{ index: number; body: (typeof prepared)[number]['body'] }> = [];

    prepared.forEach((item, index) => {
      const existingByUrl = item.urlHash ? existingByUrlHash.get(item.urlHash) : null;
      const existing = existingByUrl ?? (item.clientId ? existingByClientId.get(item.clientId) : null);
      if (existing) {
        duplicateIds.add(existing.id);
        // Only when client_id proves `existing` is THIS device's own
        // earlier attempt — a urlHash match can be a genuinely different
        // save (another device saved the same URL since the last pull), and
        // patching its description with this request's payload would
        // corrupt an unrelated row.
        const isOwnRetry = item.clientId !== null && existing.client_id === item.clientId;
        if (isOwnRetry && (item.body.description !== null || inputs[index].notes !== undefined ||
          item.body.description_format !== undefined || item.body.notes_format !== undefined)) {
          duplicateContentUpdates.set(existing.id, {
            description: item.body.description ?? undefined,
            notes: inputs[index].notes === undefined ? undefined : item.body.notes,
            description_format: item.body.description_format,
            notes_format: item.body.notes_format,
          });
        }
        outputs[index] = {
          bookmark_id: existing.id,
          status: 'duplicate',
          metadata_status: existing.metadata_status,
          client_id: existing.client_id,
          url_hash: existing.url_hash,
        };
        return;
      }
      const key = bulkCreateKey(item);
      if (key) {
        const firstIndex = pendingByKey.get(key);
        if (firstIndex !== undefined) {
          const duplicates = duplicateIndexesByInsertIndex.get(firstIndex) ?? [];
          duplicates.push(index);
          duplicateIndexesByInsertIndex.set(firstIndex, duplicates);
          return;
        }
        pendingByKey.set(key, index);
      }
      inserts.push({ index, body: item.body });
    });

    if (duplicateIds.size > 0) {
      // updateLastSavedAt applies ONE shared body to every id in one PATCH,
      // so it can't carry a per-row refreshed description — push those
      // individually, and batch the rest (the common case: a plain
      // duplicate with nothing new to say) through the cheap shared bump.
      const idsNeedingOnlyTimestamp = [...duplicateIds].filter(
        (id) => !duplicateContentUpdates.has(id),
      );
      await Promise.all([
        ...[...duplicateContentUpdates].map(([id, content]) =>
          this.updateBookmark(id, { ...content, last_saved_at: timestamp }),
        ),
        idsNeedingOnlyTimestamp.length > 0
          ? this.updateLastSavedAt(idsNeedingOnlyTimestamp, timestamp)
          : Promise.resolve(),
      ]);
    }

    if (inserts.length > 0) {
      const rows = await this.requestArray<RemoteBookmark>('/rest/v1/bookmarks', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: inserts.map((item) => item.body),
      });
      const rowsByClientId = new Map(
        rows
          .filter((row) => row.client_id)
          .map((row) => [row.client_id as string, row] as const),
      );
      const rowsByUrlHash = new Map(
        rows
          .filter((row) => row.url_hash)
          .map((row) => [row.url_hash as string, row] as const),
      );
      for (const item of inserts) {
        const preparedItem = prepared[item.index]!;
        const created =
          (preparedItem.clientId ? rowsByClientId.get(preparedItem.clientId) : undefined) ??
          (preparedItem.urlHash ? rowsByUrlHash.get(preparedItem.urlHash) : undefined);
        if (!created) {
          throw new Error('Supabase did not return every bulk-created bookmark.');
        }
        outputs[item.index] = {
          bookmark_id: created.id,
          status: 'created',
          metadata_status: created.metadata_status,
          client_id: created.client_id,
          url_hash: created.url_hash,
        };
        const duplicateIndexes = duplicateIndexesByInsertIndex.get(item.index) ?? [];
        for (const duplicateIndex of duplicateIndexes) {
          outputs[duplicateIndex] = {
            bookmark_id: created.id,
            status: 'duplicate',
            metadata_status: created.metadata_status,
            client_id: created.client_id,
            url_hash: created.url_hash,
          };
        }
      }
    }

    return outputs.map((output) => {
      if (!output) {
        throw new Error('Bulk create did not resolve every bookmark.');
      }
      return output;
    });
  }

  async listBookmarks(params: ListBookmarksParams = {}): Promise<Bookmark[]> {
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

  /** All bookmarks changed after `since` (all of them when null), oldest first. */
  async listBookmarksUpdatedSince(
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

  /** Every bookmark ID the user owns — used to detect remote deletions. */
  async listBookmarkIds(beforePage?: () => void): Promise<string[]> {
    const rows = await this.fetchAllPages<{ id: string }>('/rest/v1/bookmarks', (query) => {
      query.set('select', 'id');
      query.set('order', 'id.asc');
    }, beforePage);
    return rows.map((row) => row.id);
  }

  /** AI enrichments changed after `since` (all of them when null), oldest first. */
  async listEnrichmentsUpdatedSince(
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

  /** All of the user's tags. */
  async listTags(beforePage?: () => void): Promise<Tag[]> {
    return this.fetchAllPages<Tag>('/rest/v1/tags', (query) => {
      query.set('order', 'name.asc,id.asc');
    }, beforePage);
  }

  /** All tag links for the user's bookmarks (RLS scopes them to the owner). */
  async listBookmarkTags(beforePage?: () => void): Promise<BookmarkTag[]> {
    return this.fetchAllPages<BookmarkTag>('/rest/v1/bookmark_tags', (query) => {
      // bookmark_tags has no user_id column; RLS scopes rows to the owner.
      query.delete('user_id');
      query.set('order', 'bookmark_id.asc,tag_id.asc');
    }, beforePage);
  }

  /** All of the user's collections. */
  async listCollections(beforePage?: () => void): Promise<Collection[]> {
    return this.fetchAllPages<Collection>('/rest/v1/collections', (query) => {
      query.set('order', 'name.asc,id.asc');
    }, beforePage);
  }

  async createCollection(name: string, description?: string): Promise<Collection> {
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

  private async fetchAllPages<T>(
    path: string,
    configure: (query: URLSearchParams) => void,
    beforePage?: () => void,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      beforePage?.();
      const query = new URLSearchParams({
        select: '*',
        user_id: `eq.${this.session.user.id}`,
        limit: String(MAX_PAGE_SIZE),
        offset: String(offset),
      });
      configure(query);
      const page = await this.requestArray<T>(appendSearchParams(path, query), {
        accessToken: this.session.access_token,
      });
      all.push(...page);
      if (page.length < MAX_PAGE_SIZE) {
        return all;
      }
    }
  }

  async getBookmark(bookmarkId: string): Promise<BookmarkDetail | null> {
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

  async updateBookmark(
    bookmarkId: string,
    input: UpdateBookmarkInput & { last_saved_at?: string },
  ): Promise<Bookmark> {
    const rows = await this.requestArray<RemoteBookmark>(
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
      throw new Error(BOOKMARK_NOT_FOUND_ERROR_MESSAGE);
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

  /**
   * Batch equivalent of calling `addTags`/`updateBookmark({collection_id})` once
   * per bookmark (issue #713 / Sentry STASH-5F/5G/5D): resolves-or-creates every
   * tag and the (at most one) collection per bookmark, and links everything, in
   * one Supabase RPC call instead of one HTTP round trip per (bookmark, tag)
   * pair. Every bookmark in `items` must already exist server-side. Chunking
   * (`BULK_CREATE_SYNC_CHUNK_SIZE`) is the caller's responsibility, same as
   * `createBookmarks`.
   */
  async bulkAttachTagsAndCollections(items: BulkAttachItem[]): Promise<BulkAttachResult[]> {
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

  /**
   * Restore an AI enrichment snapshot from a Stash JSON backup (#671), without
   * clobbering a bookmark that already has one. Unlike updateAIEnrichment
   * (which always overwrites — correct for the live generation path, where a
   * fresh model result should win), a restore must only ever fill a bookmark
   * that has none yet: canonical duplicate-adoption or an account merge can
   * point the queued restore at an existing bookmark that already carries
   * real (possibly newer) enrichment, and that must never be replaced by a
   * potentially-stale imported snapshot.
   *
   * A plain INSERT with `resolution=ignore-duplicates` and an explicit
   * `on_conflict=bookmark_id` (same idiom as enqueuePendingEnrichment) makes
   * the non-clobber check atomic against a concurrent write (e.g. the server
   * trigger enriching this same bookmark) instead of a separate
   * check-then-insert that could race it. `return=representation` on an
   * ignored conflict comes back empty, which is how the caller tells "already
   * had one, restore skipped" apart from "created" — both are success: the
   * queued restore's job (make sure *some* enrichment exists) is satisfied
   * either way, so it's safe to drop from the outbox on either outcome.
   */
  async restoreAIEnrichment(input: UpdateAIEnrichmentInput): Promise<AIEnrichment | null> {
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

  /**
   * Batch equivalent of `restoreAIEnrichment` (issue #719 / Sentry STASH-5K):
   * restores many bookmarks' enrichment snapshots in one INSERT instead of one
   * HTTP round trip per bookmark. Unlike the tag/collection bulk-attach case
   * (#713), there's no cross-table linking here — `ai_enrichments` is a single
   * table with a unique `bookmark_id` — so a plain array-body POST against the
   * same `on_conflict=bookmark_id` + `resolution=ignore-duplicates` idiom as
   * the single-item method above is enough; no new RPC or migration needed.
   *
   * `return=representation` on a bulk ignore-duplicates insert comes back with
   * only the rows PostgREST actually inserted — a bookmark that already had an
   * enrichment is silently dropped from the response, same "already had one,
   * skip" semantics as the single-item method, just batched: a `bookmark_id`
   * missing from the result is still a success (nothing to restore), not a
   * failure. Chunking (`BULK_CREATE_SYNC_CHUNK_SIZE`) is the caller's
   * responsibility, same as `createBookmarks`/`bulkAttachTagsAndCollections`.
   */
  async bulkRestoreAIEnrichment(inputs: UpdateAIEnrichmentInput[]): Promise<AIEnrichment[]> {
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

  /**
   * STASH #578 Phase 2: enqueue a bookmark for the background overflow
   * worker. Called ONLY when the direct `requestEnrichment` call above was
   * rejected with 429 (quota exceeded) — this is not a replacement for the
   * synchronous path, just what happens instead of a plain failed attempt
   * once the per-user quota is exhausted.
   *
   * A plain INSERT (never an upsert) with `resolution=ignore-duplicates` and
   * an explicit `on_conflict=bookmark_id`: the table's unique `bookmark_id`
   * constraint means a repeat 429 for a bookmark that's already queued
   * silently no-ops against the existing row instead of erroring — this
   * table has no client-facing update policy, so the client can only ever
   * create its own first overflow request per bookmark, never revive or
   * reset one the worker already settled.
   *
   * STASH-4K (verified live against production before this fix): every
   * enqueue failed unconditionally with "new row violates row-level security
   * policy" since the feature shipped, regardless of session identity,
   * bookmark existence, or timing — none of it was ever the cause. The
   * table's migration deliberately grants no client-facing SELECT policy,
   * but Postgres's `ON CONFLICT` clause (DO NOTHING included, not just DO
   * UPDATE) requires SELECT privilege under RLS to check for a conflicting
   * row — with none granted, the check failed before any conflict could even
   * be evaluated. `20260731150000_pending_ai_enrichment_select_policy.sql`
   * adds a `select` policy scoped to `auth.uid() = user_id`, which is the
   * actual fix; it still never lets a client see another user's queue.
   * `on_conflict=bookmark_id` is required too: without it PostgREST's
   * conflict target defaults to the primary key (`id`, always a fresh
   * random UUID), so a genuine repeat enqueue would raise a raw 23505
   * duplicate-key error instead of the silent no-op this call is meant to
   * be. `return=minimal` avoids the default RETURNING representation this
   * call never reads.
   */
  async enqueuePendingEnrichment(bookmarkId: string, locale?: string): Promise<void> {
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

  /**
   * Current overflow-queue status for a set of bookmarks this device believes
   * are still server-queued (see the local `aiServerQueuedIds` marker in
   * store/bookmarks.tsx). Read-only, via the owner-scoped SELECT policy added
   * in `20260731150000_pending_ai_enrichment_select_policy.sql` — that policy
   * exists to make `enqueuePendingEnrichment`'s ON CONFLICT check work, but it
   * also means the client can now see its own rows' terminal status, which is
   * what this is for: reconciling a local marker against a `pending_ai_enrichment`
   * row that the worker gave up on (`status = 'failed'`, after exhausting
   * MAX_ENRICHMENT_ATTEMPTS) or that no longer exists (a deleted bookmark
   * cascades its row away). Neither of those ever produces an `ai_enrichments`
   * row, so without this check the local marker — and the "still queued,
   * resumes automatically" backlog count it drives — would say so forever for
   * a bookmark that will in fact never complete (Codex review, PR #656).
   */
  async fetchPendingEnrichmentStatuses(
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

  /**
   * Account-wide, bookmark-addressable snapshot of active and failed server AI
   * work. Settings needs IDs rather than only a total so a bookmark that is
   * simultaneously uploading, fetching metadata, and queued for AI can be
   * assigned to exactly one user-facing stage instead of being counted three
   * times. Failed rows are included for the diagnostic/attention stage; done
   * rows are terminal history and intentionally omitted.
   */
  async fetchAiQueueSnapshot(): Promise<AiServerQueueSnapshot[]> {
    return this.fetchAllPages<AiServerQueueSnapshot>(
      '/rest/v1/pending_ai_enrichment',
      (query) => {
        query.set('select', 'bookmark_id,status,attempts,created_at,updated_at');
        query.set('status', 'in.(pending,processing,failed)');
        query.set('order', 'created_at.asc,bookmark_id.asc');
      },
    );
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
    const rows = await this.requestArray<RemoteBookmark>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          url_hash: `eq.${urlHash}`,
          // "Active" must match the app's own inbox filter (deleted_at null AND
          // not archived). Without the deleted_at guard a trashed row still
          // matched here, so re-saving a trashed URL folded into the trashed row
          // as a "duplicate" and never came back — it stayed invisible in Trash.
          is_archived: 'eq.false',
          deleted_at: 'is.null',
          limit: '1',
        }),
      ),
      { accessToken: this.session.access_token },
    );

    return rows[0] ?? null;
  }

  private async findActiveBookmarksByUrlHashes(
    urlHashes: string[],
  ): Promise<Map<string, RemoteBookmark>> {
    const unique = [...new Set(urlHashes)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.requestArray<RemoteBookmark>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          url_hash: `in.${inFilter(unique)}`,
          is_archived: 'eq.false',
          deleted_at: 'is.null',
        }),
      ),
      { accessToken: this.session.access_token },
    );
    return new Map(rows.filter((row) => row.url_hash).map((row) => [row.url_hash as string, row]));
  }

  /**
   * Looks up a row by its device-generated capture id. Unlike the URL lookup
   * this is NOT filtered to active rows: client_id is globally unique per user,
   * so a retried create must resolve to its original row even if it was archived
   * in between — re-inserting would violate the unique index anyway.
   */
  private async findBookmarkByClientId(clientId: string): Promise<RemoteBookmark | null> {
    const rows = await this.requestArray<RemoteBookmark>(
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

  private async findBookmarksByClientIds(clientIds: string[]): Promise<Map<string, RemoteBookmark>> {
    const unique = [...new Set(clientIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.requestArray<RemoteBookmark>(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          select: '*',
          user_id: `eq.${this.session.user.id}`,
          client_id: `in.${inFilter(unique)}`,
        }),
      ),
      { accessToken: this.session.access_token },
    );
    return new Map(
      rows.filter((row) => row.client_id).map((row) => [row.client_id as string, row]),
    );
  }

  private async updateLastSavedAt(bookmarkIds: string[], timestamp: string): Promise<void> {
    if (bookmarkIds.length === 0) {
      return;
    }
    await this.client.request(
      appendSearchParams(
        '/rest/v1/bookmarks',
        new URLSearchParams({
          id: `in.${inFilter(bookmarkIds)}`,
          user_id: `eq.${this.session.user.id}`,
        }),
      ),
      {
        method: 'PATCH',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=minimal' },
        body: {
          last_saved_at: timestamp,
          updated_at: timestamp,
        },
      },
    );
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

  private async getCollection(collectionId: string): Promise<Collection | null> {
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

  private async listTagsForBookmark(bookmarkId: string): Promise<Tag[]> {
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

  /**
   * Server-side library reset (issue #600): one authenticated RPC that deletes
   * every row the current user owns, set-wise (bookmarks, tags, links,
   * collections, enrichments, pending enrichment queue, push tokens, API
   * keys). Returns per-table deleted-row counts. The caller owns clearing
   * local state afterwards — this only touches the cloud.
   */
  async resetLibrary(): Promise<Record<string, number>> {
    return this.client.request<Record<string, number>>('/rest/v1/rpc/reset_user_library', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: {},
    });
  }

  private async getLatestEnrichment(bookmarkId: string): Promise<AIEnrichment | null> {
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

  private async ensureTag(name: string, slug: string, source: TagSource): Promise<Tag> {
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

  private async findTagsBySlugs(slugs: string[]): Promise<Tag[]> {
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
}

export function createBookmarkApi(session: SupabaseAuthSession): BookmarkApi {
  return new BookmarkApi(session);
}
