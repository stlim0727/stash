# Durable offline tagging (#850)

Manual tags can be added and removed before a bookmark has synced. Sample rows
remain read-only. Folder assignment and AI requests retain their remote gates.
Editing an assignment means removing its old name and adding the new one; this
change does not introduce a library-wide tag rename/delete UI.

## Journal and recovery

`pending_tag_ops` is the existing structured outbox in repository metadata:
SQLite `meta` on native and `stash.meta` in web localStorage. An `add` represents
create-or-resolve-tag followed by assign-tag; the existing bulk-attach RPC does
both atomically. A separate create-tag queue entry would duplicate that RPC's
idempotent name resolution. `remove` represents remove-association.

Each target (bookmark ID, normalized tag name) keeps its latest intent, with an
operation UUID, source, confidence and creation time. Opposite edits replace
rather than cancel: a previous request could already have reached the server.
Acknowledgements clear only the exact UUID they uploaded. Local edits compute against the latest state inside the serialized journal queue.
They persist the journal before publishing or writing the derived snapshot and
before starting upload. Failed writes return an error without changing the queue
or the visible/cached association.
The tag snapshot is derived data: startup replays the journal over the cached
snapshot, including if a crash interrupted the snapshot write.

## Upload and pull

Tag uploads run one at a time and only under the reconciled cache owner.
Associations wait for `hasSyncedOnce`; the bookmark's UUID alone is not evidence
of remote existence. Local-only images keep tags locally until image/create sync
becomes available. Pause blocks upload. Changes made during an upload request a
follow-up sync. Responses from a departed identity or reset epoch are discarded.
Reset refuses while a tag upload or serialized tag mutation is in flight.

Failures retain the operation and persist retry count, attempt time and error
kind. Automatic retries use the bookmark queue's exponential schedule (5, 15,
30, 60, 120, 300 seconds, capped), with its 3x network/DNS multiplier. Manual
Sync now bypasses backoff. A cancellable timer wakes sync at the earliest eligible
failed-operation deadline, including after restart. Cleanup also cancels a wake-up
already waiting for journal persistence, so it cannot start sync after unmount. Pause, auth/cache ownership,
bookmark creation, and storage health gate automatic retry. One durable health marker escalates at attempt 3 for
ordinary errors or 6 for network/DNS errors through existing observability.

A successful remove becomes a confirmed tombstone. Pull still replays it, so a
stale remote snapshot cannot resurrect the association. The tombstone is retired
only when a replaced remote tag snapshot confirms that the association is absent;
an anonymous pull that preserves the local cache cannot retire it. Removing an
assignment retains the catalog tag, matching the existing backend semantics.

## Account changes

Identity rekeys occupy the same serial journal queue as local edits. Account
transitions hold that queue through the atomic bookmark/queue/tag-state commit,
so edits arriving during a rekey resolve their IDs afterwards. Existing atomic
identity replacement carries bookmark, queue, tag links and journal together. Carry-over queues already-synced links as well as pending
operations under the new bookmark IDs, dedupes by target, and resets retry state
for the new account. Pending removes stay removes. Duplicate adoption rekeys
existing operations without treating it as an account migration. A real-account
switch retains the existing purge rules; expired sessions retain their existing
cache isolation behavior.

## Evidence and limits

Regression checks cover offline edits and provider restart, journal-only recovery,
write failures (including restart and overlapping edits), create-before-association
ordering, persisted retry backoff, automatic deadline retries and pause/resume,
manual retry, in-flight add/remove acknowledgement, anonymous carry-over, and
a stalled journal write racing duplicate adoption and a second edit.
The real web repository also verifies metadata survives reinitialization.
Existing native SQLite metadata writes are awaited; this change adds no schema or
backend deployment. Physical-device process termination, the full UX matrix and
participant testing remain deferred with #849. Browser/local storage can still be
cleared by its owner or the OS; journal durability is within that storage lifetime.
