import { flushSync } from 'react-dom';

/**
 * Web default (native override in `sync-flush.native.ts`). Runs `fn`'s state
 * updates synchronously so the DOM (and any ref attached during that commit)
 * is up to date before this call returns — needed so a `.focus()` called
 * right after stays inside the same synchronous gesture-handler call stack
 * as the originating tap. Some mobile browsers only reliably honor a
 * programmatic focus while that stack is still live; a focus queued into a
 * later effect/microtask risks missing that window on some engines, even
 * though it wasn't the cause of STASH-33/34/35/36/37 (the real fix there was
 * suppressing the list's on-drag keyboard dismissal — see the comment above
 * `openSearch` in `app/index.tsx`). Kept as a defensive synchronous-focus
 * path since removing it has never actually been verified safe in the field.
 */
export function syncFlush(fn: () => void): void {
  flushSync(fn);
}
