# Bookmark store modules

The parent provider owns shared state and refs. Keep dependencies explicit and
preserve callback identity, reset epochs, account checks, and durable ordering.
Never inject the entire context or create a second queue/identity owner.

- Capture must publish optimistically and resolve durable persistence separately.
- Import waits for the initial library to settle and serializes local writes.
- Sync uploads before pull, protects queued edits, and keeps bulk reconcile
  follow-ups sequential. Identity adoption/rehome use the same atomic rekey path.
- Reset, import flushing, pause, and sync retain distinct busy guards; consult
  `docs/architecture/sync-pause-import-reset.md` before changing those guards.
- Hydration and command writes share `repository-ready.ts`'s init promise.
- Account checks and background tasks read live refs, not competing snapshots.

Use the repo-root task map for module/test pairs. Run the existing race,
account-switch, durable snapshot, reset, import, and AI regression suites for
changes spanning modules. Keep the public `store/bookmarks.tsx` exports stable.
