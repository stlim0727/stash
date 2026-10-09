import { repository } from "@/storage/repository";

// Single shared init so background writes can never race ahead of table
// creation/seeding, even for saves made before the startup load finishes.
// Exported so a startup-time reader outside this provider (e.g.
// `_layout.tsx`'s durable-diagnostics hydration) can sequence itself after
// the SAME shared init this component would otherwise kick off on mount —
// calling it early just starts that shared promise sooner, it does not
// duplicate work.
export let repositoryReady: Promise<void> | null = null;

export function ensureRepositoryReady(): Promise<void> {
  if (!repositoryReady) {
    // A fresh install starts empty — no sample bookmarks/tags/collections are
    // seeded. `init` still runs to create the tables and mark the store seeded
    // (so the empty state is durable), it just inserts nothing.
    repositoryReady = repository.init([]);
    // A failed init must not poison the whole session — clear the cached
    // rejection so the next call retries (e.g. after a transient warm-start
    // open failure).
    repositoryReady.catch(() => {
      repositoryReady = null;
    });
  }
  return repositoryReady;
}
