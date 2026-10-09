import { appendSearchParams, BOOKMARK_NOT_FOUND_ERROR_MESSAGE, bulkCreateKey, descriptionFromInput, inFilter, nowIso, remoteToBookmark, requirePayload } from '@/api/bookmark-helpers';
import { type BulkCreateBookmarkOutput, type CreateBookmarkOutput, type RemoteBookmark, type UpdateBookmarkInput } from '@/api/bookmark-types';
import type {
  Bookmark,
  CreateBookmarkInput
} from '@/domain/types';
import { canonicalizeUrl, normalizeUrl } from '@/domain/urls';
import { makeUuid } from '@/domain/uuid';
import type { RequestOptions, StashSupabaseClient } from '@/supabase/client';
import { SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

interface ImageUploadTargetDependencies {
  session: SupabaseAuthSession;
  client: StashSupabaseClient;
}

export function imageUploadTarget(this: ImageUploadTargetDependencies,
  bookmarkId: string,
  contentType: string,
): { uploadUrl: string; publicUrl: string; headers: Record<string, string> } {
  const path = `${this.session.user.id}/${bookmarkId}`;
  return this.client.storageUploadTarget('bookmark-images', path, {
    accessToken: this.session.access_token,
    contentType,
  });
}

interface DeleteImagesDependencies {
  session: SupabaseAuthSession;
  client: StashSupabaseClient;
}

export async function deleteImages(this: DeleteImagesDependencies, bookmarkIds: string[]): Promise<void> {
  const paths = bookmarkIds.map((id) => `${this.session.user.id}/${id}`);
  await this.client.removeStorageObjects('bookmark-images', paths, this.session.access_token);
}

interface CreateBookmarkDependencies {
  findActiveBookmarkByUrlHash: (urlHash: string) => Promise<RemoteBookmark | null>;
  findBookmarkByClientId: (clientId: string) => Promise<RemoteBookmark | null>;
  updateBookmark: (bookmarkId: string, input: UpdateBookmarkInput & { last_saved_at?: string; }) => Promise<Bookmark>;
  session: SupabaseAuthSession;
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  findBookmarkById: (id: string) => Promise<RemoteBookmark | null>;
}

export async function createBookmark(this: CreateBookmarkDependencies, input: CreateBookmarkInput): Promise<CreateBookmarkOutput> {
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
      collection_id: existing.collection_id,
    };
  }

  const canonicalUrl =
    payload.url && input.canonical_url ? normalizeUrl(input.canonical_url) : null;
  const createBody = {
    // The client's own permanent id for this bookmark (see CreateBookmarkInput.id).
    // Sent explicitly so Postgres uses it as the primary key instead of
    // generating a new one — the local row never has to adopt a different id.
    id: input.id,
    user_id: this.session.user.id,
    url: payload.url,
    canonical_url: canonicalUrl,
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
    collection_id: input.collection_id ?? null,
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
    if (
      error instanceof SupabaseRequestError &&
      error.status === 403 &&
      Boolean(createBody.collection_id) &&
      error.message.toLowerCase().includes('row-level security')
    ) {
      return createBookmark.call(this, {
        ...input,
        collection_id: null,
      });
    }

    // If a concurrent (or retried) insert won the race between our lookup and
    // our own insert, treat the unique-index conflict as the documented
    // duplicate save. Try the active-URL key first, then fall back to the
    // client_id key: a retried URL create whose original was archived in the
    // meantime conflicts on the all-rows client_id index (not the active-only
    // url_hash one), so the url_hash lookup alone would miss the archived
    // original and leave the entry failing forever.
    if (error instanceof SupabaseRequestError && error.status === 409) {
      // The primary key is the final idempotency key. Rows created before
      // `client_id` can miss both ordinary lookups after their URL changes or
      // they move to Trash; without this lookup their retry remains stuck on
      // `bookmarks_pkey` forever (STASH-4Z).
      const duplicateById = input.id ? await this.findBookmarkById(input.id) : null;
      const duplicateByUrl = urlHash ? await this.findActiveBookmarkByUrlHash(urlHash) : null;
      const duplicate =
        duplicateById ?? duplicateByUrl ??
        (clientId ? await this.findBookmarkByClientId(clientId) : null);
      if (duplicate) {
        // Same idempotent-retry case as the pre-insert `existing` branch
        // above (see its comment) — the insert itself lost the race to
        // this request's own earlier attempt, so apply the same
        // permanent-id/client-id-proven refreshed description here too.
        const isOwnRetry = duplicate.id === input.id ||
          (clientId !== null && duplicate.client_id === clientId);
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
          collection_id: duplicate.collection_id,
        };
      }

      // When input.id collided with bookmarks_pkey belonging to another user
      // (e.g. after logout or account transition), RLS prevents findBookmarkById
      // from seeing the row. Because bookmarks_pkey is a global constraint across
      // all users in public.bookmarks, this user cannot insert with input.id.
      // Mint a fresh UUID and retry the insert so the bookmark can be saved (STASH-6T).
      const isPkeyConflict =
        error.message.includes('bookmarks_pkey') ||
        error.message.includes('unique constraint');
      if (isPkeyConflict && input.id) {
        const freshId = makeUuid();
        const retryBody = {
          ...createBody,
          id: freshId,
        };
        const retryRows = await this.requestArray<RemoteBookmark>('/rest/v1/bookmarks', {
          method: 'POST',
          accessToken: this.session.access_token,
          headers: { Prefer: 'return=representation' },
          body: retryBody,
        });
        const retryCreated = retryRows[0];
        if (!retryCreated) {
          throw new Error('Supabase did not return the created bookmark after pkey retry.');
        }
        return {
          bookmark_id: retryCreated.id,
          status: 'duplicate',
          metadata_status: retryCreated.metadata_status,
          collection_id: retryCreated.collection_id,
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
    collection_id: created.collection_id,
  };
}

interface CreateBookmarksDependencies {
  session: SupabaseAuthSession;
  findActiveBookmarksByUrlHashes: (urlHashes: string[]) => Promise<Map<string, RemoteBookmark>>;
  findBookmarksByClientIds: (clientIds: string[]) => Promise<Map<string, RemoteBookmark>>;
  updateBookmark: (bookmarkId: string, input: UpdateBookmarkInput & { last_saved_at?: string; }) => Promise<Bookmark>;
  updateLastSavedAt: (bookmarkIds: string[], timestamp: string) => Promise<void>;
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  createBookmark: (input: CreateBookmarkInput) => Promise<CreateBookmarkOutput>;
}

export async function createBookmarks(this: CreateBookmarksDependencies, inputs: CreateBookmarkInput[]): Promise<BulkCreateBookmarkOutput[]> {
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
    const canonicalUrl =
      payload.url && input.canonical_url ? normalizeUrl(input.canonical_url) : null;
    return {
      urlHash,
      clientId,
      body: {
        // See createBookmark's createBody: sent explicitly so Postgres uses
        // it as the primary key instead of generating a new one.
        id: input.id,
        user_id: this.session.user.id,
        url: payload.url,
        canonical_url: canonicalUrl,
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
        collection_id: input.collection_id ?? null,
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
      const hasContent = item.body.description !== null || inputs[index].notes !== undefined;
      if (isOwnRetry && hasContent) {
        duplicateContentUpdates.set(existing.id, {
          description: item.body.description ?? undefined,
          notes: inputs[index].notes === undefined ? undefined : item.body.notes,
          description_format: item.body.description !== null ? item.body.description_format : undefined,
          notes_format: inputs[index].notes !== undefined ? item.body.notes_format : undefined,
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
    let rows: RemoteBookmark[];
    try {
      rows = await this.requestArray<RemoteBookmark>('/rest/v1/bookmarks', {
        method: 'POST',
        accessToken: this.session.access_token,
        headers: { Prefer: 'return=representation' },
        body: inserts.map((item) => item.body),
      });
    } catch (error) {
      if (
        !(error instanceof SupabaseRequestError) ||
        (error.status !== 409 &&
          !(error.status === 403 && error.message.toLowerCase().includes('row-level security')))
      ) {
        throw error;
      }

      // A single legacy row whose original create landed without a response
      // can make the whole atomic bulk INSERT fail on `bookmarks_pkey`. Retry
      // this exceptional path item-by-item: createBookmark's 409 recovery can
      // identify that owner-scoped row by its permanent id, while unrelated
      // rows in the chunk still upload normally. The common bulk path keeps
      // its one-request behavior.
      const settled = await Promise.allSettled(
        inserts.map(async (item) => ({
          item,
          result: await this.createBookmark(inputs[item.index]!),
        })),
      );
      // Promise.all would reject as soon as the first retry fails, leaving
      // sibling requests detached while syncInFlight unwinds. Keep the busy
      // guard active until every already-launched write has settled, then
      // propagate the first failure without publishing partial results.
      const recovered = settled.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      for (const { item, result } of recovered) {
        const preparedItem = prepared[item.index]!;
        outputs[item.index] = {
          ...result,
          client_id: preparedItem.clientId,
          url_hash: preparedItem.urlHash,
        };
        const duplicateIndexes = duplicateIndexesByInsertIndex.get(item.index) ?? [];
        for (const duplicateIndex of duplicateIndexes) {
          outputs[duplicateIndex] = {
            ...result,
            status: 'duplicate',
            client_id: preparedItem.clientId,
            url_hash: preparedItem.urlHash,
          };
        }
      }
      rows = [];
    }
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
      if (outputs[item.index]) {
        continue;
      }
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
        collection_id: created.collection_id,
        client_id: created.client_id,
        url_hash: created.url_hash,
      };
      const duplicateIndexes = duplicateIndexesByInsertIndex.get(item.index) ?? [];
      for (const duplicateIndex of duplicateIndexes) {
        outputs[duplicateIndex] = {
          bookmark_id: created.id,
          status: 'duplicate',
          metadata_status: created.metadata_status,
          collection_id: created.collection_id,
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

interface UpdateBookmarkDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function updateBookmark(this: UpdateBookmarkDependencies,
  bookmarkId: string,
  input: UpdateBookmarkInput & { last_saved_at?: string },
): Promise<Bookmark> {
  try {
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
  } catch (error) {
    if (
      error instanceof SupabaseRequestError &&
      error.status === 403 &&
      Boolean(input.collection_id) &&
      error.message.toLowerCase().includes('row-level security')
    ) {
      return updateBookmark.call(this, bookmarkId, {
        ...input,
        collection_id: null,
      });
    }
    throw error;
  }
}

interface DeleteBookmarkDependencies {
  updateBookmark: (bookmarkId: string, input: UpdateBookmarkInput & { last_saved_at?: string; }) => Promise<Bookmark>;
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function deleteBookmark(this: DeleteBookmarkDependencies, bookmarkId: string, permanent = false): Promise<void> {
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

interface FindActiveBookmarkByUrlHashDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findActiveBookmarkByUrlHash(this: FindActiveBookmarkByUrlHashDependencies, urlHash: string): Promise<RemoteBookmark | null> {
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

interface FindActiveBookmarksByUrlHashesDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findActiveBookmarksByUrlHashes(this: FindActiveBookmarksByUrlHashesDependencies,
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

interface FindBookmarkByClientIdDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findBookmarkByClientId(this: FindBookmarkByClientIdDependencies, clientId: string): Promise<RemoteBookmark | null> {
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

interface FindBookmarkByIdDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findBookmarkById(this: FindBookmarkByIdDependencies, id: string): Promise<RemoteBookmark | null> {
  const rows = await this.requestArray<RemoteBookmark>(
    appendSearchParams(
      '/rest/v1/bookmarks',
      new URLSearchParams({
        select: '*',
        user_id: `eq.${this.session.user.id}`,
        id: `eq.${id}`,
        limit: '1',
      }),
    ),
    { accessToken: this.session.access_token },
  );
  return rows[0] ?? null;
}

interface FindBookmarksByClientIdsDependencies {
  requestArray: <T>(path: string, options?: RequestOptions | undefined) => Promise<T[]>;
  session: SupabaseAuthSession;
}

export async function findBookmarksByClientIds(this: FindBookmarksByClientIdsDependencies, clientIds: string[]): Promise<Map<string, RemoteBookmark>> {
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

interface UpdateLastSavedAtDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function updateLastSavedAt(this: UpdateLastSavedAtDependencies, bookmarkIds: string[], timestamp: string): Promise<void> {
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

interface ResetLibraryDependencies {
  client: StashSupabaseClient;
  session: SupabaseAuthSession;
}

export async function resetLibrary(this: ResetLibraryDependencies): Promise<Record<string, number>> {
  return this.client.request<Record<string, number>>('/rest/v1/rpc/reset_user_library', {
    method: 'POST',
    accessToken: this.session.access_token,
    body: {},
  });
}
