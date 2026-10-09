import * as enrichment from '@/api/bookmark-enrichment';
import { appendSearchParams, MAX_PAGE_SIZE } from '@/api/bookmark-helpers';
import * as organization from '@/api/bookmark-organization';
import * as reads from '@/api/bookmark-reads';
import { type AddTagsInput, type ApplyAISuggestionsInput, type BookmarkDetail, type BulkAttachItem, type BulkAttachResult, type BulkCreateBookmarkOutput, type CreateBookmarkOutput, type EnrichmentMetadataHint, type ListBookmarksParams, type RemoteBookmark, type RemoveTagsInput, type UpdateAIEnrichmentInput, type UpdateBookmarkInput } from '@/api/bookmark-types';
import * as writes from '@/api/bookmark-writes';
import type { AiServerQueueSnapshot } from '@/domain/processing-status';
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  CreateBookmarkInput,
  Tag,
  TagSource
} from '@/domain/types';
import type { StashSupabaseClient } from '@/supabase/client';
import { createSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';
export { AI_ENRICH_REQUEST_TIMEOUT_MS, BOOKMARK_NOT_FOUND_ERROR_MESSAGE } from '@/api/bookmark-helpers';
export { type AddTagsInput, type ApplyAISuggestionsInput, type BookmarkDetail, type BulkAttachItem, type BulkAttachResult, type BulkCreateBookmarkOutput, type CreateBookmarkOutput, type EnrichmentMetadataHint, type ListBookmarksParams, type RemoteBookmark, type RemoveTagsInput, type UpdateAIEnrichmentInput, type UpdateBookmarkInput } from '@/api/bookmark-types';

export class BookmarkApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) { }

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
    return writes.imageUploadTarget.call({ session: this.session, client: this.client }, bookmarkId, contentType);
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
    return writes.deleteImages.call({ session: this.session, client: this.client }, bookmarkIds);
  }

  async createBookmark(input: CreateBookmarkInput): Promise<CreateBookmarkOutput> {
    return writes.createBookmark.call({ findActiveBookmarkByUrlHash: this.findActiveBookmarkByUrlHash.bind(this), findBookmarkByClientId: this.findBookmarkByClientId.bind(this), updateBookmark: this.updateBookmark.bind(this), session: this.session, requestArray: this.requestArray.bind(this), findBookmarkById: this.findBookmarkById.bind(this) }, input);
  }

  async createBookmarks(inputs: CreateBookmarkInput[]): Promise<BulkCreateBookmarkOutput[]> {
    return writes.createBookmarks.call({ session: this.session, findActiveBookmarksByUrlHashes: this.findActiveBookmarksByUrlHashes.bind(this), findBookmarksByClientIds: this.findBookmarksByClientIds.bind(this), updateBookmark: this.updateBookmark.bind(this), updateLastSavedAt: this.updateLastSavedAt.bind(this), requestArray: this.requestArray.bind(this), createBookmark: this.createBookmark.bind(this) }, inputs);
  }

  async listBookmarks(params: ListBookmarksParams = {}): Promise<Bookmark[]> {
    return reads.listBookmarks.call({ listBookmarksByTags: this.listBookmarksByTags.bind(this), baseBookmarkListParams: this.baseBookmarkListParams.bind(this), requestArray: this.requestArray.bind(this), session: this.session }, params);
  }

  /** All bookmarks changed after `since` (all of them when null), oldest first. */
  async listBookmarksUpdatedSince(
    since: string | null,
    beforePage?: () => void,
  ): Promise<Bookmark[]> {
    return reads.listBookmarksUpdatedSince.call({ fetchAllPages: this.fetchAllPages.bind(this) }, since, beforePage);
  }

  /** Every bookmark ID the user owns — used to detect remote deletions. */
  async listBookmarkIds(beforePage?: () => void): Promise<string[]> {
    return reads.listBookmarkIds.call({ fetchAllPages: this.fetchAllPages.bind(this) }, beforePage);
  }

  /** AI enrichments changed after `since` (all of them when null), oldest first. */
  async listEnrichmentsUpdatedSince(
    since: string | null,
    beforePage?: () => void,
  ): Promise<AIEnrichment[]> {
    return enrichment.listEnrichmentsUpdatedSince.call({ fetchAllPages: this.fetchAllPages.bind(this) }, since, beforePage);
  }

  /** All of the user's tags. */
  async listTags(beforePage?: () => void): Promise<Tag[]> {
    return organization.listTags.call({ fetchAllPages: this.fetchAllPages.bind(this) }, beforePage);
  }

  /** All tag links for the user's bookmarks (RLS scopes them to the owner). */
  async listBookmarkTags(beforePage?: () => void): Promise<BookmarkTag[]> {
    return organization.listBookmarkTags.call({ fetchAllPages: this.fetchAllPages.bind(this) }, beforePage);
  }

  /** All of the user's collections. */
  async listCollections(beforePage?: () => void): Promise<Collection[]> {
    return organization.listCollections.call({ fetchAllPages: this.fetchAllPages.bind(this) }, beforePage);
  }

  async createCollection(name: string, description?: string): Promise<Collection> {
    return organization.createCollection.call({ requestArray: this.requestArray.bind(this), session: this.session }, name, description);
  }

  async updateCollection(
    collectionId: string,
    updates: { name?: string; description?: string | null },
  ): Promise<Collection> {
    return organization.updateCollection.call({ requestArray: this.requestArray.bind(this), session: this.session }, collectionId, updates);
  }

  async deleteCollection(
    collectionId: string,
    action: 'uncategorize' | 'trash' = 'uncategorize',
  ): Promise<void> {
    return organization.deleteCollection.call({ deleteCollections: this.deleteCollections.bind(this) }, collectionId, action);
  }

  async deleteCollections(
    collectionIds: string[],
    action: 'uncategorize' | 'trash' = 'uncategorize',
  ): Promise<void> {
    return organization.deleteCollections.call({ client: this.client, session: this.session }, collectionIds, action);
  }

  async mergeCollections(
    sourceCollectionIds: string[],
    targetCollectionId: string,
  ): Promise<void> {
    return organization.mergeCollections.call({ client: this.client, session: this.session }, sourceCollectionIds, targetCollectionId);
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
    return reads.getBookmark.call({ requestArray: this.requestArray.bind(this), session: this.session, listTagsForBookmark: this.listTagsForBookmark.bind(this), getCollection: this.getCollection.bind(this), getLatestEnrichment: this.getLatestEnrichment.bind(this) }, bookmarkId);
  }

  async updateBookmark(
    bookmarkId: string,
    input: UpdateBookmarkInput & { last_saved_at?: string },
  ): Promise<Bookmark> {
    return writes.updateBookmark.call({ requestArray: this.requestArray.bind(this), session: this.session }, bookmarkId, input);
  }

  async deleteBookmark(bookmarkId: string, permanent = false): Promise<void> {
    return writes.deleteBookmark.call({ updateBookmark: this.updateBookmark.bind(this), client: this.client, session: this.session }, bookmarkId, permanent);
  }

  async addTags(input: AddTagsInput): Promise<Tag[]> {
    return organization.addTags.call({ ensureTag: this.ensureTag.bind(this), client: this.client, session: this.session }, input);
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
    return organization.bulkAttachTagsAndCollections.call({ requestArray: this.requestArray.bind(this), session: this.session }, items);
  }

  async removeTags(input: RemoveTagsInput): Promise<void> {
    return organization.removeTags.call({ findTagsBySlugs: this.findTagsBySlugs.bind(this), client: this.client, session: this.session }, input);
  }

  async updateAIEnrichment(input: UpdateAIEnrichmentInput): Promise<AIEnrichment> {
    return enrichment.updateAIEnrichment.call({ getLatestEnrichment: this.getLatestEnrichment.bind(this), session: this.session, requestArray: this.requestArray.bind(this) }, input);
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
    return enrichment.restoreAIEnrichment.call({ requestArray: this.requestArray.bind(this), session: this.session }, input);
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
    return enrichment.bulkRestoreAIEnrichment.call({ requestArray: this.requestArray.bind(this), session: this.session }, inputs);
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
    return enrichment.requestEnrichment.call({ client: this.client, session: this.session }, bookmarkId, metadata, locale);
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
    return enrichment.enqueuePendingEnrichment.call({ client: this.client, session: this.session }, bookmarkId, locale);
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
    return enrichment.fetchPendingEnrichmentStatuses.call({ requestArray: this.requestArray.bind(this), session: this.session }, bookmarkIds);
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
    return enrichment.fetchAiQueueSnapshot.call({ fetchAllPages: this.fetchAllPages.bind(this) });
  }

  async applyAISuggestions(input: ApplyAISuggestionsInput): Promise<BookmarkDetail | null> {
    return enrichment.applyAISuggestions.call({ addTags: this.addTags.bind(this), updateBookmark: this.updateBookmark.bind(this), getBookmark: this.getBookmark.bind(this) }, input);
  }

  private async findActiveBookmarkByUrlHash(urlHash: string): Promise<RemoteBookmark | null> {
    return writes.findActiveBookmarkByUrlHash.call({ requestArray: this.requestArray.bind(this), session: this.session }, urlHash);
  }

  private async findActiveBookmarksByUrlHashes(
    urlHashes: string[],
  ): Promise<Map<string, RemoteBookmark>> {
    return writes.findActiveBookmarksByUrlHashes.call({ requestArray: this.requestArray.bind(this), session: this.session }, urlHashes);
  }

  /**
   * Looks up a row by its device-generated capture id. Unlike the URL lookup
   * this is NOT filtered to active rows: client_id is globally unique per user,
   * so a retried create must resolve to its original row even if it was archived
   * in between — re-inserting would violate the unique index anyway.
   */
  private async findBookmarkByClientId(clientId: string): Promise<RemoteBookmark | null> {
    return writes.findBookmarkByClientId.call({ requestArray: this.requestArray.bind(this), session: this.session }, clientId);
  }

  /**
   * Looks up an owner-scoped row by the permanent id minted at capture. This
   * is the last-resort idempotency key for rows created before `client_id` was
   * introduced, or whose URL no longer matches the current local payload.
   */
  private async findBookmarkById(id: string): Promise<RemoteBookmark | null> {
    return writes.findBookmarkById.call({ requestArray: this.requestArray.bind(this), session: this.session }, id);
  }

  private async findBookmarksByClientIds(clientIds: string[]): Promise<Map<string, RemoteBookmark>> {
    return writes.findBookmarksByClientIds.call({ requestArray: this.requestArray.bind(this), session: this.session }, clientIds);
  }

  private async updateLastSavedAt(bookmarkIds: string[], timestamp: string): Promise<void> {
    return writes.updateLastSavedAt.call({ client: this.client, session: this.session }, bookmarkIds, timestamp);
  }

  private baseBookmarkListParams(params: ListBookmarksParams): URLSearchParams {
    return reads.baseBookmarkListParams.call({ session: this.session }, params);
  }

  private async listBookmarksByTags(params: ListBookmarksParams): Promise<Bookmark[]> {
    return reads.listBookmarksByTags.call({ requestArray: this.requestArray.bind(this), session: this.session, baseBookmarkListParams: this.baseBookmarkListParams.bind(this) }, params);
  }

  private async getCollection(collectionId: string): Promise<Collection | null> {
    return organization.getCollection.call({ requestArray: this.requestArray.bind(this), session: this.session }, collectionId);
  }

  private async listTagsForBookmark(bookmarkId: string): Promise<Tag[]> {
    return organization.listTagsForBookmark.call({ requestArray: this.requestArray.bind(this), session: this.session }, bookmarkId);
  }

  /**
   * Server-side library reset (issue #600): one authenticated RPC that deletes
   * every row the current user owns, set-wise (bookmarks, tags, links,
   * collections, enrichments, pending enrichment queue, push tokens, API
   * keys). Returns per-table deleted-row counts. The caller owns clearing
   * local state afterwards — this only touches the cloud.
   */
  async resetLibrary(): Promise<Record<string, number>> {
    return writes.resetLibrary.call({ client: this.client, session: this.session });
  }

  private async getLatestEnrichment(bookmarkId: string): Promise<AIEnrichment | null> {
    return enrichment.getLatestEnrichment.call({ requestArray: this.requestArray.bind(this), session: this.session }, bookmarkId);
  }

  private async ensureTag(name: string, slug: string, source: TagSource): Promise<Tag> {
    return organization.ensureTag.call({ findTagsBySlugs: this.findTagsBySlugs.bind(this), requestArray: this.requestArray.bind(this), session: this.session }, name, slug, source);
  }

  private async findTagsBySlugs(slugs: string[]): Promise<Tag[]> {
    return organization.findTagsBySlugs.call({ requestArray: this.requestArray.bind(this), session: this.session }, slugs);
  }
}

export function createBookmarkApi(session: SupabaseAuthSession): BookmarkApi {
  return new BookmarkApi(session);
}
