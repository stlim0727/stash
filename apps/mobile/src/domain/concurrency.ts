/**
 * A minimal async concurrency limiter (Sentry STASH-3B). Importing 500+
 * bookmarks fired one metadata-enrichment fetch per bookmark all at once —
 * hundreds of concurrent network requests through Android's native stack —
 * and the resource exhaustion aborted the ART runtime (native SIGABRT). The
 * startup pending-enrichment backfill has the same shape, so a relaunch after
 * the crash re-fired the whole burst: a crash loop. Bounding how many tasks
 * run at once fixes both paths.
 *
 * `run` executes the task immediately when a slot is free, otherwise queues it
 * FIFO. The returned promise settles with the task's outcome (rejections
 * propagate to the caller; a rejected task still frees its slot).
 */
export function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    const resume = waiting.shift();
    if (resume) {
      // Hand the slot directly to the next waiter — never decrement first, or
      // a new caller could slip in between and overshoot the limit.
      resume();
    } else {
      active -= 1;
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
