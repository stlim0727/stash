/**
 * Plans and applies local bookmark cache transitions when the signed-in
 * Supabase user changes between syncs. This exists because a pull reconciles
 * local rows against the *current* account's remote IDs — so without this,
 * switching accounts would make the pull treat the previous account's bookmarks
 * as "deleted remotely" and wipe them locally (the data-loss bug this fixes).
 *
 * The model (see docs/architecture/sync-account-switching.md):
 *  - Anonymous → real account: the anonymous data belongs to whoever signs in,
 *    so CARRY IT OVER — re-home those rows as fresh local creates that upload to
 *    the new account. (The lossless path is Supabase identity linking, which
 *    keeps the same user_id and never triggers a switch at all.)
 *  - Real account A → real account B: you're a different person now, so REPLACE
 *    — drop A's local cache (safe: it stays in A's cloud) and load B's data.
 *  - Same user / first sync: nothing to do.
 *
 * `planAccountTransition` is pure and unit-tested under the Node runner.
 * `applyAccountTransition` is side-effectful (state + repository writes) and
 * takes its dependencies injected so the planner stays independently testable.
 */

import { createPayloadFromBookmark } from '@/domain/create-payload';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { recordLog } from '@/observability/log-buffer';
import type { BookmarkRepository, IdentityRekeyState } from '@/storage/types';
import { hasRemoteIdentity, isLocalOnlyBookmark } from '@/sync/sync-bookmarks';

export interface SyncedUserRef {
  id: string;
  isAnonymous: boolean;
}

export type AccountTransitionKind = 'first' | 'none' | 'carry-over' | 'switch' | 'logout';

export interface AccountTransitionPlan {
  kind: AccountTransitionKind;
  /** Rows (owned by a previous ANONYMOUS user) to re-home as new local creates. */
  rehome: Bookmark[];
  /** Row ids (owned by a previous REAL account) to drop from the local cache. */
  drop: string[];
  /**
   * Queue entry `local_id`s to remove alongside the dropped rows. An already-
   * synced cloud bookmark that the previous account then edited or deleted flips
   * to `sync_status: 'pending'` with an `update`/`delete` queue entry keyed to
   * that account's remote UUID (see sync-bookmarks.ts). If we drop the row but
   * KEEP the entry, the next minted account's background sync would run that
   * update/delete under a DIFFERENT JWT against a UUID it doesn't own (RLS/404 →
   * failEntry → the edit is silently stranded and lost). So the dropped rows'
   * queue entries must be removed in lockstep. Always a subset of `drop`.
   */
  dropQueue: string[];
  /**
   * Local-only image rows (see `isLocalOnlyBookmark`) whose binary already
   * uploaded to the departing ANONYMOUS account's own Storage path, but whose
   * `createBookmark` call was never confirmed (still queued for retry, or
   * gave up as `sync_status: 'failed'`) — so they're not in `rehome` either
   * (that's deliberately synced-only). Unlike `rehome`, these keep their
   * existing id and queue entry (no cloud row was ever created under either
   * account for this id, so there's no conflict to avoid); only their stale
   * `preview_image_url` needs clearing so the existing queued create's normal
   * `!preview_image_url` upload step re-uploads the same still-on-disk file
   * under the new account's own Storage path instead of retrying with the
   * old account's URL baked in.
   */
  resetImageUrls: Bookmark[];
  /** Whether the pull watermark must be reset for a full refresh of the new user. */
  resetWatermark: boolean;
}

/**
 * Rows that can be CARRIED OVER (re-homed) from a previous ANONYMOUS account:
 * confirmed synced to that account's cloud. Device-local/seed rows are never
 * touched — they belong to no account yet. Seed/sample rows are marked
 * `sync_status: 'synced'` locally too (so the orphan self-heal never tries to
 * upload them), even though their `bookmark-…` id was never a real cloud row —
 * `hasRemoteIdentity` filters those out; every genuine bookmark (old-scheme or
 * new) has a real UUID id regardless of sync state, so this never excludes a
 * legitimately synced row. `synced` also makes a transition self-idempotent:
 * once re-homed (now `pending` under a freshly-minted id), a row no longer
 * matches.
 *
 * Re-home is deliberately `synced`-only: a not-yet-synced row has no confirmed
 * cloud copy under the anon account, and its create entry is still in the queue,
 * so leaving it untouched lets it upload under the new account as-is — EXCEPT
 * for an image bookmark's binary, which uploads to Storage before the row is
 * ever created and so can be a "confirmed cloud object" under the anon account
 * despite the row itself never syncing (see `staleUploadedImageRows` below,
 * which catches exactly that gap).
 *
 * `isLocalOnlyBookmark` excludes rows (e.g. image bookmarks) marked `synced`
 * purely as local "nothing to upload" bookkeeping, never a real cloud row —
 * same reasoning as the seed/sample exclusion above. Without it, re-homing
 * would re-queue one as a `create` under the new account via
 * `createPayloadFromBookmark`, which has no image-upload support (STASH-65).
 */
function cloudOwnedRows(localBookmarks: Bookmark[]): Bookmark[] {
  return localBookmarks.filter(
    (bookmark) =>
      hasRemoteIdentity(bookmark.id) &&
      bookmark.sync_status === 'synced' &&
      !isLocalOnlyBookmark(bookmark),
  );
}

/**
 * Local-only image rows (`isLocalOnlyBookmark`) that already have a real,
 * uploaded Storage object sitting at the departing ANONYMOUS account's own
 * path (`imageUploadTarget` keys the path by session user id — see
 * api/bookmarks.ts) — the binary upload landed but `createBookmark` was
 * never confirmed, so the row is still `pending` (mid-retry) or gave up as
 * `failed`. `cloudOwnedRows` misses these on purpose (re-home is
 * synced-only); without this separate pass, the still-queued `create` entry
 * retries as-is under the new account, and `syncQueueEntry`'s
 * `!preview_image_url` idempotency guard (see sync-bookmarks.ts) skips
 * re-uploading because a URL is already set — so the new account's row
 * would end up pointing at an object under the OLD anonymous user's path,
 * which it can never manage and which vanishes if that anon user is later
 * cleaned up.
 *
 * Unlike `rehome`, these rows keep their existing id and queue entry: no
 * cloud row was ever created under this id by ANY account (the create call
 * itself is what's still pending/failed), so there's no id conflict to
 * avoid by minting a new one, and the existing queue entry already retries
 * this same bookmark. Only the stale URL needs clearing.
 */
function staleUploadedImageRows(localBookmarks: Bookmark[]): Bookmark[] {
  return localBookmarks.filter(
    (bookmark) => isLocalOnlyBookmark(bookmark) && Boolean(bookmark.preview_image_url),
  );
}

/**
 * Rows owned by the previously-signed-in CLOUD account that must be DROPPED on a
 * real-account departure (logout, or a real A→real B switch): every row EVER
 * confirmed synced to that account's cloud (`Bookmark.ever_synced`), REGARDLESS
 * of current sync_status.
 *
 * Crucially this includes rows the account edited or deleted after they were
 * synced — those flip to `sync_status: 'pending'` with an `update`/`delete` queue
 * entry keyed to the account's remote UUID. `sync_status` alone can't tell that
 * case apart from a fresh, never-synced local create — both read `'pending'` —
 * which is exactly what `ever_synced` records. A synced-only filter would KEEP
 * those rows (and their queue entries), so the next minted account's sync would
 * fire the update/delete under a different identity against a UUID it doesn't
 * own (RLS/404 → the edit silently stranded). Dropping these rows, plus
 * removing the matching queue entries (`dropQueue`), closes that data-loss hole.
 *
 * Capture is sacred: never-synced LOCAL creates (`ever_synced` unset, not
 * `synced`) are NOT matched here and survive to upload under the next account.
 * Discarding an unsynced EDIT to a cloud bookmark is the deliberate trade-off:
 * the bookmark itself is safe in that account's cloud, and keeping the queued
 * op would strand it under a different identity, so we drop the op.
 *
 * `hasRemoteIdentity` and `isLocalOnlyBookmark` exclude seed/sample and
 * local-only rows the same way `cloudOwnedRows` does — see its comment.
 * Without the latter exclusion here, a local-only image bookmark would be
 * DROPPED (deleted) on logout / a real A→real B switch as if it were the
 * departing account's cloud row, even though it was never uploaded (STASH-65).
 */
function cloudRemoteRows(localBookmarks: Bookmark[]): Bookmark[] {
  return localBookmarks.filter(
    (bookmark) =>
      hasRemoteIdentity(bookmark.id) &&
      (bookmark.sync_status === 'synced' || bookmark.ever_synced === true) &&
      !isLocalOnlyBookmark(bookmark),
  );
}

/**
 * Plans the local-cache cleanup that runs on logout (sign-out to the
 * `signed_out` state) BEFORE any new account exists.
 *
 * With lazy anonymous creation, logout no longer mints a new user and no sync
 * runs, so the just-logged-out real account's bookmarks would otherwise linger
 * in the local cache — stale, and a privacy leak to the next anonymous user on
 * the device. So we DROP all of that account's cloud-identity rows (their data is
 * safe in the real account's cloud) and reset the watermark, like a real A→real
 * B switch but with no "B" yet.
 *
 * Capture is sacred: never-synced LOCAL captures (no remote identity) are
 * intentionally LEFT in place. They have never reached any cloud account, carry
 * no other account's identity, and will upload under whatever account the next
 * save mints. We DO drop rows the account edited/deleted after syncing (now
 * pending with an update/delete queued to that account's UUID): the bookmark is
 * safe in the account's cloud, and keeping the queued op would strand it under
 * a different identity (RLS/404), so the op is dropped with the row (`dropQueue`).
 */
export function planLogoutCacheClear(localBookmarks: Bookmark[]): AccountTransitionPlan {
  const owned = cloudRemoteRows(localBookmarks);
  const dropIds = owned.map((bookmark) => bookmark.id);
  return {
    kind: 'logout',
    rehome: [],
    drop: dropIds,
    // Queue entries are keyed by local_id, which for a synced row equals its
    // remote UUID — so the dropped ids ARE the keys of their update/delete ops.
    dropQueue: dropIds,
    // No new account exists yet to re-upload under (lazy anonymous creation),
    // so there's nothing to reset here — see staleUploadedImageRows, only
    // relevant to the carry-over case below.
    resetImageUrls: [],
    resetWatermark: true,
  };
}

export function planAccountTransition(
  previous: SyncedUserRef | null,
  current: SyncedUserRef,
  localBookmarks: Bookmark[],
): AccountTransitionPlan {
  if (previous === null) {
    return {
      kind: 'first',
      rehome: [],
      drop: [],
      dropQueue: [],
      resetImageUrls: [],
      resetWatermark: false,
    };
  }
  if (previous.id === current.id) {
    return {
      kind: 'none',
      rehome: [],
      drop: [],
      dropQueue: [],
      resetImageUrls: [],
      resetWatermark: false,
    };
  }

  if (previous.isAnonymous) {
    // Carry-over: re-home synced rows only (see cloudOwnedRows). Their create
    // entries are re-issued under the new account, so nothing is queue-dropped.
    // staleUploadedImageRows catches the separate not-yet-synced-row-but-
    // already-uploaded-binary gap cloudOwnedRows deliberately doesn't cover.
    return {
      kind: 'carry-over',
      rehome: cloudOwnedRows(localBookmarks),
      resetImageUrls: staleUploadedImageRows(localBookmarks),
      drop: [],
      dropQueue: [],
      resetWatermark: true,
    };
  }
  if (current.isAnonymous) {
    // Real account → anonymous. This is NEVER a deliberate "different person"
    // switch: an explicit sign-out routes through planLogoutCacheClear, not
    // here. It only happens when a real session fails to restore and the app
    // minted a throwaway anonymous user (e.g. a transient secure-store read
    // miss the auth layer couldn't classify as a real account). Dropping the
    // cache here destroyed the user's local view of data that is still theirs
    // (and still in their cloud) — the silent empty-Inbox "logged out" screen.
    // So PRESERVE it: leave every row in place. The pull's deletion-skip guard
    // (userChanged) already prevents these rows being wiped, and re-signing into
    // the real account (same user id) restores full sync. Defense-in-depth
    // alongside the auth layer's `session_expired` handling, which normally
    // prevents this anonymous mint from happening at all.
    return {
      kind: 'none',
      rehome: [],
      drop: [],
      dropQueue: [],
      resetImageUrls: [],
      resetWatermark: true,
    };
  }
  // Real A → real B: drop ALL of A's cloud-identity rows (synced AND
  // pending-edit/delete) plus their queued ops, same data-loss reasoning as
  // logout — keeping a pending update/delete keyed to A's UUID would fire it
  // under B and 404/RLS-fail, stranding the edit.
  const owned = cloudRemoteRows(localBookmarks);
  const dropIds = owned.map((bookmark) => bookmark.id);
  return {
    kind: 'switch',
    rehome: [],
    drop: dropIds,
    dropQueue: dropIds,
    resetImageUrls: [],
    resetWatermark: true,
  };
}

/**
 * Applies an account transition plan: re-homes anonymous bookmarks under the
 * new account or drops cached rows from the previous real account. Side-
 * effectful — mutates React state and writes to the repository. Dependencies
 * are injected so this can be called from the store without creating a
 * top-level import cycle.
 */
export async function applyAccountTransition(
  plan: AccountTransitionPlan,
  repository: BookmarkRepository,
  setBookmarks: (updater: (prev: Bookmark[] | null) => Bookmark[] | null) => void,
  setQueue: (updater: (prev: LocalPendingBookmark[]) => LocalPendingBookmark[]) => void,
  makeBookmarkId: () => string,
  ensureRepositoryReady: () => Promise<void>,
  /**
   * Tag state (pending tag ops + optimistic tag links) is keyed by bookmark id,
   * so an account transition that re-homes or drops bookmark ids must move that
   * state in lockstep:
   *  - `rehome(idMap)` re-keys old→new local id on carry-over. Without it a
   *    re-homed bookmark's queued tag ops still target its OLD id — absent in
   *    the new account — and `syncTagOps` fires `addTags` against a non-existent
   *    bookmark, silently dropping the carried-over tags.
   *  - `drop(ids)` purges tag state for the previous REAL account's rows on a
   *    real A→real B switch. Without it, account A's pending tag ops and links
   *    survive into account B's session and `syncTagOps` (which runs right after
   *    under B's auth) uploads A's tags as B and surfaces them in B's UI — a
   *    cross-account leak.
   */
  tagState: {
    rehome?: (
      idMap: Map<string, string>,
    ) => void | IdentityRekeyState | Promise<void | IdentityRekeyState>;
    drop?: (ids: string[]) => void | Promise<void>;
  } = {},
): Promise<void> {
  if (plan.rehome.length > 0) {
    const now = new Date().toISOString();
    const rehomedById = new Map<string, Bookmark>();
    /** old bookmark id -> new bookmark id, for re-keying tag state below. */
    const idMap = new Map<string, string>();
    const newEntries: LocalPendingBookmark[] = [];
    for (const old of plan.rehome) {
      const newId = makeBookmarkId();
      idMap.set(old.id, newId);
      // ever_synced resets: the new id has never synced under this account,
      // regardless of whether the old row (under the old id) ever had.
      //
      // An image's previously-uploaded object lives at the OLD account's own
      // Storage path (`{old_user_id}/{old_bookmark_id}`, see
      // api/bookmarks.ts's imageUploadTarget). Owner-scoped Storage RLS
      // means the NEW account can never manage (update or delete) an object
      // under a different user's path segment, and if the abandoned
      // anonymous user is later cleaned up, that object could vanish out
      // from under this now-real bookmark. Clear preview_image_url here so
      // create-sync's normal "!preview_image_url" upload step (see
      // syncQueueEntry in sync-bookmarks.ts) re-uploads the SAME local file
      // — still on disk, this is the same device, only the signed-in
      // identity changed — under the new account's own path from the start.
      const rehomed: Bookmark = {
        ...old,
        id: newId,
        ...(old.content_type === 'image' ? { preview_image_url: null } : {}),
        sync_status: 'pending',
        ever_synced: false,
        updated_at: now,
      };
      rehomedById.set(old.id, rehomed);
      newEntries.push({
        local_id: newId,
        remote_id: null,
        operation: 'create',
        // Rebuild from the (already rehomed, image URL cleared) row,
        // carrying a text note's body back as shared_text so URL-less notes
        // still upload to the new account, under the freshly-minted id so
        // the create uploads with a stable identity from the start (see
        // createPayloadFromBookmark).
        payload: { ...createPayloadFromBookmark(rehomed), id: newId },
        sync_status: 'pending',
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      });
    }
    recordLog('warn', `account switch: re-homing ${plan.rehome.length} bookmark(s) into the new account`);
    setBookmarks((current) =>
      (current ?? []).map((bookmark) => rehomedById.get(bookmark.id) ?? bookmark),
    );
    setQueue((current) => [...current, ...newEntries]);
    // Re-key tag ops/links onto the new local ids so the carried-over tags
    // upload against the re-homed bookmark instead of an id the new account
    // never had.
    const identityState = await tagState.rehome?.(idMap);
    await ensureRepositoryReady();
    const replacements = [...rehomedById].map(([previousId, bookmark]) => ({
      previousId,
      bookmark,
    }));
    if (identityState && repository.replaceBookmarkIdentities) {
      await repository.replaceBookmarkIdentities(replacements, newEntries, identityState);
    } else {
      for (const { previousId, bookmark } of replacements) {
        await repository.replaceBookmark(previousId, bookmark);
      }
      for (const entry of newEntries) {
        await repository.enqueue(entry);
      }
    }
  }
  if (plan.resetImageUrls.length > 0) {
    // Unlike rehome above, these rows keep their existing id and queue entry
    // (see staleUploadedImageRows) — only the stale, old-account-owned
    // preview_image_url needs clearing so the already-queued create's normal
    // "!preview_image_url" upload step re-uploads the same still-on-disk file
    // under the new account's own Storage path.
    const now = new Date().toISOString();
    const resetById = new Map<string, Bookmark>();
    for (const old of plan.resetImageUrls) {
      resetById.set(old.id, { ...old, preview_image_url: null, updated_at: now });
    }
    recordLog(
      'warn',
      `account switch: clearing ${plan.resetImageUrls.length} stale anon-owned image URL(s) pending re-upload`,
    );
    setBookmarks((current) =>
      (current ?? []).map((bookmark) => resetById.get(bookmark.id) ?? bookmark),
    );
    await ensureRepositoryReady();
    // Sequential, not Promise.all — same single-SQLite-connection reasoning
    // as the drop loop below.
    for (const bookmark of resetById.values()) {
      await repository.updateBookmark(bookmark);
    }
  }
  if (plan.drop.length > 0) {
    const dropped = new Set(plan.drop);
    // Diagnostics must reflect the actual kind: a logout is not an account
    // switch, so don't log "account switch: …" on it (NIT #7 — misleading logs).
    const reason = plan.kind === 'logout' ? 'logout' : 'account switch';
    recordLog(
      'warn',
      `${reason}: dropping ${plan.drop.length} cached bookmark(s) from the previous account`,
    );
    setBookmarks((current) => (current ?? []).filter((bookmark) => !dropped.has(bookmark.id)));
    // Drop the dropped rows' queued ops too. An update/delete keyed to the
    // departing account's remote UUID would otherwise run under the next
    // identity (logout → next anon mint, or account B) against a row it doesn't
    // own → RLS/404 → failEntry → the user's edit silently stranded. Discarding
    // an unsynced edit here is deliberate: the bookmark itself is safe in the
    // departing account's cloud; keeping the op would lose it under a stranger.
    const droppedQueue = new Set(plan.dropQueue);
    if (droppedQueue.size > 0) {
      setQueue((current) => current.filter((entry) => !droppedQueue.has(entry.local_id)));
    }
    // Purge the dropped rows' tag state too, symmetric to the re-home re-key:
    // otherwise account A's pending tag ops/links leak into account B's session
    // and syncTagOps uploads them as B.
    await tagState.drop?.(plan.drop);
    await ensureRepositoryReady();
    // Sequential, not Promise.all: fanning many simultaneous calls onto the
    // single serialized SQLite connection stalls it for seconds on a large
    // library (docs/architecture/sqlite-write-contention.md — the same "fan-
    // out onto one actor" bug already fixed 4x elsewhere for this reason).
    for (const id of plan.drop) {
      await repository.deleteBookmark(id);
    }
    // Remove the queue entries durably too, not just in memory — otherwise the
    // next launch re-loads them from the repository and fires them under the new
    // identity.
    for (const localId of droppedQueue) {
      await repository.removeQueueEntry(localId);
    }
  }
}
