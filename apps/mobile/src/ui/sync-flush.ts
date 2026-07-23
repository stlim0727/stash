import { flushSync } from 'react-dom';

/**
 * Web default (native override in `sync-flush.native.ts`). Runs `fn`'s state
 * updates synchronously so the DOM (and any ref attached during that commit)
 * is up to date before this call returns — needed so a `.focus()` called
 * right after stays inside the same synchronous gesture-handler call stack
 * as the originating tap. Some mobile browsers (notably WebKit) only honor a
 * programmatic focus as "user-initiated" while that stack is still live; a
 * focus queued into a later effect/microtask can silently fail to keep the
 * keyboard/focus, even though the DOM focus event still fires (STASH-33/34).
 */
export function syncFlush(fn: () => void): void {
  flushSync(fn);
}
