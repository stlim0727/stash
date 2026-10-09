import { captureAnalytics } from "@/analytics/capture-bridge";
import { createSyncRecoveredEvent } from "@/analytics/events";
import {
  type PendingTagOp
} from "@/domain/pending-tags";
import type {
  Bookmark,
  LocalPendingBookmark
} from "@/domain/types";
import { canonicalizeUrl } from "@/domain/urls";
import { makeUuid } from "@/domain/uuid";
import { recordLog } from "@/observability/log-buffer";
import { type AiRetryState } from '@/store/bookmarks/types';
import {
  UPLOAD_RETRY_BACKOFF_MS,
  hasRemoteIdentity,
  isLocalOnlyBookmark
} from "@/sync/sync-bookmarks";

export function captureSyncRecovery(entry: LocalPendingBookmark): void {
  if (entry.operation !== "create" || entry.retry_count < 1) return;
  captureAnalytics(
    createSyncRecoveredEvent(
      entry.retry_count,
      entry.last_attempt_at,
      entry.last_error_kind ?? "unknown",
    ),
  );
  recordLog(
    "info",
    `create sync recovered after ${entry.retry_count} failed run(s) (${entry.last_error_kind ?? "unknown"})`,
  );
}

export function isBookmarkSyncedOnce(bookmark: Bookmark): boolean {
  return (
    hasRemoteIdentity(bookmark.id) &&
    (bookmark.sync_status === "synced" || bookmark.ever_synced === true) &&
    // Local-only rows (e.g. a not-yet-uploaded image bookmark) are marked
    // `sync_status: 'synced'` as pure local bookkeeping, never confirmed by
    // the server. Without this exclusion, editing/deleting/tagging one
    // enqueued a remote mutation against a row that doesn't exist server-side;
    // the API's not-found response then made syncQueueEntry treat it as
    // "deleted on another device" and delete the local row too (STASH-65).
    !isLocalOnlyBookmark(bookmark)
  );
}

/** Parse the persisted AI-retry bookkeeping map, tolerating absent/corrupt
 *  values (mirrors `parseIdSet`/`parseTagOps` for the store's other durable
 *  meta blobs). */
export function parseAiRetryState(raw: string | null): Record<string, AiRetryState> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, AiRetryState> = {};
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as AiRetryState).firstAttemptAt === "string" &&
        typeof (value as AiRetryState).lastAttemptAt === "string" &&
        typeof (value as AiRetryState).attemptCount === "number"
      ) {
        result[id] = value as AiRetryState;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function parseIdSet(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/**
 * A bookmark's permanent id, minted once at capture time. Sent to the server
 * as the row's own primary key (see CreateBookmarkInput.id / api/bookmarks.ts)
 * so a create never has to hand back a different id for the client to adopt —
 * there is no local→remote id swap. Same UUID format `client_id` already used
 * (and still uses, as a separate idempotency key — see createPayloadFromBookmark),
 * so a bookmark's own id and its capture id are indistinguishable in shape;
 * they're kept as two separate fields on purpose, not merged.
 */
export function makeBookmarkId(): string {
  return makeUuid();
}

/**
 * A UUID-format capture id for {@link Bookmark.client_id}. The cloud
 * `bookmarks.client_id` column is `uuid`, so the format must be valid.
 */
export function makeClientId(): string {
  return makeUuid();
}

/**
 * The current canonical dedupe key for an already-stored bookmark. Recomputed
 * from the URL rather than trusting the persisted `url_hash`, so a row saved by
 * an older build — whose hash predates a canonicalization change (e.g. the
 * YouTube `si` strip) and hasn't yet been rewritten by pull sync — still
 * dedupes against a fresh save instead of creating the duplicate this is meant
 * to prevent. Falls back to the stored hash when the row has no URL.
 */
export function currentDedupeKey(
  bookmark: Pick<Bookmark, "url" | "url_hash">,
): string | null {
  return bookmark.url ? canonicalizeUrl(bookmark.url) : bookmark.url_hash;
}

/**
 * "Active" the same way the inbox filter defines it: not trashed and not
 * archived. Save-time dedupe must only match active rows — otherwise re-saving a
 * URL that is sitting in Trash folds into the trashed row and leaves it hidden,
 * so it never comes back. Mirrors the server-side active-URL predicate.
 */
export function isActiveBookmark(
  bookmark: Pick<Bookmark, "deleted_at" | "is_archived">,
): boolean {
  return !bookmark.deleted_at && !bookmark.is_archived;
}

export function tagRetryReadyAt(op: PendingTagOp): number {
  if (!op.last_attempt_at || !op.retry_count) return 0;
  const base = UPLOAD_RETRY_BACKOFF_MS[Math.min(op.retry_count - 1, UPLOAD_RETRY_BACKOFF_MS.length - 1)]!;
  const multiplier = op.last_error_kind === "transient_network" || op.last_error_kind === "transient_dns" ? 3 : 1;
  return Date.parse(op.last_attempt_at) + base * multiplier;
}

/** Parse the persisted tag-op queue, tolerating absent/corrupt values. */
export function parseTagOps(raw: string | null): PendingTagOp[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
        (op): op is PendingTagOp =>
          !!op &&
          typeof op.bookmark_id === "string" &&
          typeof op.tag_name === "string" &&
          (op.op === "add" || op.op === "remove"),
      )
      : [];
  } catch {
    return [];
  }
}

export function logStorageError(operation: string, error: unknown) {
  console.warn(
    `[stash] failed to persist ${operation}; state remains in memory`,
    error,
  );
}

/**
 * A handful of the bulk-create reconcile follow-up's local writes have
 * nothing else that will ever retry them once completeCreateSyncBatch has
 * already marked the underlying create synced and dequeued it (see the
 * mid-flight-delete and reconcile-update loops in
 * `applyBulkCreateChunkResults`) — a single transient failure there would
 * otherwise be unrecoverable for the rest of the session (caught in PR
 * review). Bounded, short-delay retry for that specific case; not a general
 * storage-retry utility.
 */
export async function retryStorageWrite<T>(op: () => Promise<T>): Promise<T> {
  const attempts = 3;
  const delayMs = 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/** Append items from `loaded` that aren't already present (by key). */
export function mergeById<T>(
  current: T[],
  loaded: T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...loaded.filter((item) => !seen.has(key(item)))];
}
