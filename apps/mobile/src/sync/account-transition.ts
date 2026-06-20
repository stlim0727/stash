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
import type { BookmarkRepository } from '@/storage/types';
import { hasRemoteIdentity } from '@/sync/sync-bookmarks';

export interface SyncedUserRef {
  id: string;
  isAnonymous: boolean;
}

export type AccountTransitionKind = 'first' | 'none' | 'carry-over' | 'switch';

export interface AccountTransitionPlan {
  kind: AccountTransitionKind;
  /** Rows (owned by a previous ANONYMOUS user) to re-home as new local creates. */
  rehome: Bookmark[];
  /** Row ids (owned by a previous REAL account) to drop from the local cache. */
  drop: string[];
  /** Whether the pull watermark must be reset for a full refresh of the new user. */
  resetWatermark: boolean;
}

/**
 * Rows owned by the previously-synced cloud account: a real remote identity
 * (Supabase UUID) and already `synced`. Device-local/seed rows are never
 * touched — they have no remote identity and belong to no account yet. The
 * remote-identity check also makes a transition self-idempotent: once re-homed
 * (now a local id) or dropped (gone), a row no longer matches.
 */
function cloudOwnedRows(localBookmarks: Bookmark[]): Bookmark[] {
  return localBookmarks.filter(
    (bookmark) => hasRemoteIdentity(bookmark.id) && bookmark.sync_status === 'synced',
  );
}

export function planAccountTransition(
  previous: SyncedUserRef | null,
  current: SyncedUserRef,
  localBookmarks: Bookmark[],
): AccountTransitionPlan {
  if (previous === null) {
    return { kind: 'first', rehome: [], drop: [], resetWatermark: false };
  }
  if (previous.id === current.id) {
    return { kind: 'none', rehome: [], drop: [], resetWatermark: false };
  }

  const owned = cloudOwnedRows(localBookmarks);
  if (previous.isAnonymous) {
    return { kind: 'carry-over', rehome: owned, drop: [], resetWatermark: true };
  }
  return { kind: 'switch', rehome: [], drop: owned.map((bookmark) => bookmark.id), resetWatermark: true };
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
  makeLocalId: () => string,
  ensureRepositoryReady: () => Promise<void>,
): Promise<void> {
  if (plan.rehome.length > 0) {
    const now = new Date().toISOString();
    const rehomedById = new Map<string, Bookmark>();
    const newEntries: LocalPendingBookmark[] = [];
    for (const old of plan.rehome) {
      const newId = makeLocalId();
      rehomedById.set(old.id, { ...old, id: newId, sync_status: 'pending', updated_at: now });
      newEntries.push({
        local_id: newId,
        remote_id: null,
        operation: 'create',
        // Rebuild from the stored row, carrying a text note's body back as
        // shared_text so URL-less notes still upload to the new account.
        payload: createPayloadFromBookmark(old),
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
    await ensureRepositoryReady();
    for (const [oldId, rehomed] of rehomedById) {
      await repository.replaceBookmark(oldId, rehomed);
    }
    for (const entry of newEntries) {
      await repository.enqueue(entry);
    }
  }
  if (plan.drop.length > 0) {
    const dropped = new Set(plan.drop);
    recordLog('warn', `account switch: dropping ${plan.drop.length} cached bookmark(s) from the previous account`);
    setBookmarks((current) => (current ?? []).filter((bookmark) => !dropped.has(bookmark.id)));
    await ensureRepositoryReady();
    await Promise.all(plan.drop.map((id) => repository.deleteBookmark(id)));
  }
}
