# Sync & account switching

How Stash keeps your bookmarks safe when the signed-in user changes. This
documents the fix for a data-loss bug where signing into a new account could
wipe the local bookmark cache.

## The problem

Stash is **anonymous-first**: on first launch it creates an anonymous Supabase
user and syncs bookmarks under that user. Signing in with Apple/Google moves you
to a permanent account.

Pull-sync reconciles the **local** cache against the **current account's** remote
rows. Remote deletions are detected by diffing the full remote ID list: a local
row that is `synced`, has a real remote identity (a Supabase UUID), and is *not*
in the remote ID list is assumed to have been deleted on another device, so it's
removed locally.

That logic is correct **only when the account hasn't changed**. If you sign into
a *different* account (e.g. manual linking was off, so Google created a separate,
empty account), every bookmark synced under the previous account "isn't in this
account's ID list" → the pull deleted the **local** copies. No error, just an
empty inbox.

> Important: the pull only deletes **local** rows. It never deletes the cloud
> rows, so data synced under the previous user still exists in Supabase under
> that user id — it's recoverable, just not visible while signed into the other
> account.

## The model

A sync must **never** delete local rows merely because they're missing from a
*different* account than the one they were saved under. Beyond that guardrail,
two situations are handled by their natural mental model:

| Transition | Behavior | Why |
| --- | --- | --- |
| **Anonymous → real account** | **Carry over** — re-home the anonymous bookmarks as fresh local creates that upload to the new account. | Anonymous data belongs to whoever signs in. Losing it on sign-in is the most jarring thing an app can do here. |
| **Real account A → real account B** | **Replace** — drop A's local cache (it stays safe in A's cloud) and load B's data. | You're a different person now; merging A into B would be confusing and a privacy leak. |
| **Same user / first sync** | No-op. | Nothing to reconcile. |

The cleanest carry-over is actually **Supabase identity linking**: linking the
OAuth identity to the anonymous user keeps the **same `user_id`**, so nothing
moves and no switch happens at all. The app already attempts this on sign-in;
enabling **manual linking** in the Supabase dashboard (see
`docs/development/setup.md`) makes the common case completely lossless. The
re-home path is the fallback for when linking can't happen.

## Implementation

- **`src/sync/account-transition.ts`** — `planAccountTransition(previous, current, localBookmarks)`
  is a pure function returning a plan (`carry-over` → `rehome`, `switch` → `drop`,
  `none`/`first` → nothing). Only **cloud-owned** rows (real remote identity +
  `synced`) are ever touched; device-local and seeded rows are left alone. The
  remote-identity check makes the plan **self-idempotent**: once a row is
  re-homed (now a local id) or dropped (gone), it no longer matches, so a retry
  does nothing.
- **`src/sync/pull-bookmarks.ts`** — `pullRemoteChanges` takes the `currentUser`
  and tracks the last-synced user in repository meta (`synced_user_id`,
  `synced_user_is_anonymous`). On a user change it **skips the deletion diff**
  (defense-in-depth) and **resets the watermark** for a full refresh. It also
  records the switch and any deletions to the in-app log buffer (visible via
  Settings → Report a problem → Share diagnostics & logs).
- **`src/store/bookmarks.tsx`** — `syncNow` runs the transition plan just before
  the pull: re-homed rows become local `pending` creates (and upload on the next
  sync); dropped rows are removed from the cache.

## Known limitations / follow-ups

- Re-home carries the **bookmarks**; tag/collection/enrichment links that pointed
  at the old account's remote IDs are not re-homed (they refresh from the new
  account on pull). Full tag/collection carry-over is a follow-up. Tag state
  keyed by bookmark id (pending tag ops + optimistic tag links) IS kept in
  lockstep with id changes, via `applyAccountTransition`'s `tagState` callbacks:
  - **carry-over** (`tagState.rehome`) re-keys ops/links old→new local id, so
    user-authored tags queued before sign-in still upload against the re-homed
    row instead of an id the new account never had;
  - **switch A→B** (`tagState.drop`) purges A's ops/links, so `syncTagOps`
    (which runs next under B's auth) can't upload A's tags as B or surface them
    in B's UI.
  Separately, the post-create sync reconcile (`store/bookmarks.tsx`) re-keys tag
  state from the local id to the freshly-minted remote id once a re-homed (or
  any pre-sync) bookmark's create uploads — otherwise the carried-over op stays
  parked on a non-remote id that `syncTagOps` skips and never uploads.
- The lossless, no-data-movement path is identity linking; prefer enabling manual
  linking over relying on re-homing.
