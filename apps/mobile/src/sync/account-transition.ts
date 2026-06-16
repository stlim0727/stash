/**
 * Decides what to do with the LOCAL bookmark cache when the signed-in Supabase
 * user changes between syncs. This exists because a pull reconciles local rows
 * against the *current* account's remote IDs — so without this, switching
 * accounts would make the pull treat the previous account's bookmarks as
 * "deleted remotely" and wipe them locally (the data-loss bug this fixes).
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
 * Pure and dependency-light so it is unit-tested under the Node runner.
 */

import type { Bookmark } from '@/domain/types';
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
