/**
 * Recent-searches engine — the user's own recent search strings, kept as an
 * ordered most-recent-first list. Pure and platform-free so the trim/dedupe/cap
 * rules are unit-tested without React, mirroring `@/domain/sort`.
 *
 * Privacy: recent searches are user content. They persist ONLY in the local
 * preference (meta) store via `pref.search.recents` and are never enqueued,
 * uploaded, or synced — the same posture as `pref.inbox.sort`.
 */

/** Persistence key in the repository meta store (local-only, never synced). */
export const RECENT_SEARCHES_PREF_KEY = 'pref.search.recents';

/** Max entries kept in storage. Older entries past this drop off the tail. */
export const RECENT_SEARCHES_CAP = 8;

/** Max entries surfaced in the suggestion shelf (a subset of what's stored). */
export const RECENT_SEARCHES_SHOWN = 6;

/**
 * Parse the persisted JSON string array back into a clean recents list. Anything
 * malformed (not an array, non-string members, blank strings) is dropped rather
 * than thrown — a corrupt pref must never break the screen. Trims, drops blanks,
 * de-dupes case-insensitively (keeping the first occurrence), and caps the
 * result so a hand-edited or legacy value can't exceed the contract.
 */
export function parseRecents(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return normalizeRecents(parsed.filter((entry): entry is string => typeof entry === 'string'));
}

/** Serialize a recents list for persistence (a plain JSON string array). */
export function serializeRecents(list: string[]): string {
  return JSON.stringify(list);
}

/**
 * Trim, drop blanks, and de-dupe case-insensitively (first occurrence wins),
 * then cap to {@link RECENT_SEARCHES_CAP}. Order is otherwise preserved, so the
 * caller decides recency ordering.
 */
function normalizeRecents(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
    if (out.length >= RECENT_SEARCHES_CAP) {
      break;
    }
  }
  return out;
}

/**
 * Record a freshly-submitted query: trim it, ignore an empty result, then
 * prepend it to the list. A case-insensitive match anywhere in the list is
 * moved to the front (re-searching promotes rather than duplicates), and the
 * list is capped so the oldest entry drops off. Returns a NEW array; the input
 * is never mutated. The trimmed (display) casing of the new entry wins.
 */
export function addRecent(list: string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return list;
  }
  const key = trimmed.toLowerCase();
  const rest = list.filter((entry) => entry.trim().toLowerCase() !== key);
  return normalizeRecents([trimmed, ...rest]);
}

/**
 * Remove a single recent entry (case-insensitive match on the trimmed string).
 * Backs the long-press-to-remove affordance. Returns a NEW array.
 */
export function removeRecent(list: string[], query: string): string[] {
  const key = query.trim().toLowerCase();
  if (!key) {
    return list;
  }
  return list.filter((entry) => entry.trim().toLowerCase() !== key);
}
