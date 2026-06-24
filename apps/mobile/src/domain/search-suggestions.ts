/**
 * Search-suggestion builder — turns the user's already-loaded, user-authored
 * inputs (recent searches, applied tags, used folders) into the ordered, capped
 * chip list the suggestion shelf renders. Pure and platform-free so the
 * ordering/cap/dedupe rules are unit-tested without React.
 *
 * FIELD SEPARATION (non-negotiable): this builder accepts ONLY user-authored
 * inputs — recent search strings the user typed, tag counts derived from tags
 * the user applied, and folders the user created/used. It has no access to and
 * never emits AI-suggested-but-unaccepted tags, a model's proposed collection
 * name, or any generated metadata. The input contract is the guarantee.
 */

import {
  RECENT_SEARCHES_SHOWN,
  RECENT_SEARCHES_CAP,
} from '@/domain/recent-searches';

/** Visible cap on top tags surfaced in the shelf (by frequency, desc). */
export const SUGGESTION_TAGS_SHOWN = 8;
/** Visible cap on top folders surfaced in the shelf (by bookmark count, desc). */
export const SUGGESTION_FOLDERS_SHOWN = 8;

/** A folder the user has used: at least one inbox bookmark lives in it. */
export interface SuggestionFolder {
  id: string;
  name: string;
  /** How many inbox bookmarks are filed in this folder (drives ordering). */
  count: number;
}

/** A tag the user has applied, with how many inbox bookmarks carry it. */
export interface SuggestionTagCount {
  id: string;
  name: string;
  count: number;
}

/** The kinds of chip the shelf can render, in their row order. */
export type SuggestionKind = 'recent' | 'tag' | 'folder';

/**
 * One shelf chip. `filter` is the facet a tag/folder chip applies when tapped
 * (recents fill the query instead, so they carry none). `query` carries the raw
 * recent string for fill + long-press-remove. The shape is intentionally flat
 * so the presentational component (ST-1) needs no data logic.
 */
export interface SearchSuggestion {
  kind: SuggestionKind;
  /** Stable React key / testID seed (e.g. `recent:디자인`, `tag:t-123`). */
  key: string;
  /** The visible chip label (raw query, `#tag`, or folder name). */
  label: string;
  /** Present for tag/folder chips: the facet to apply on tap. */
  filter?: { kind: 'tag' | 'collection'; id: string };
  /** Present for recent chips: the raw query to fill / remove. */
  query?: string;
}

export interface BuildSearchSuggestionsInput {
  /** Recent search strings, most-recent-first (already trimmed/deduped). */
  recents: string[];
  /** Applied-tag counts (the `buildTagCloud` input — user tags only). */
  tagCounts: SuggestionTagCount[];
  /** Folders containing ≥1 inbox bookmark. */
  folders: SuggestionFolder[];
  /**
   * Phase-2 seam: the live query. UNUSED in Phase 1 (the shelf only shows on an
   * empty query), but accepted now so Phase 2's live-filter swap doesn't reshape
   * this signature.
   */
  query?: string;
}

/**
 * Build the ordered chip list: recents first (caller-supplied recency order,
 * capped to the shown count), then top tags by frequency desc (ties alpha),
 * then top folders by bookmark count desc (ties alpha). Blank-named tags/folders
 * are dropped so they never render as empty pills, matching the browse shelf.
 *
 * Cross-family overlap (a recent string equal to a tag/folder name) is kept on
 * purpose: a recent re-runs a text search while a tag/folder applies a facet —
 * different actions the icons disambiguate, exactly as the browse shelf already
 * lets a `#tag` and a like-named folder coexist.
 */
export function buildSearchSuggestions(
  input: BuildSearchSuggestionsInput,
): SearchSuggestion[] {
  const recentChips: SearchSuggestion[] = input.recents
    .map((query) => query.trim())
    .filter((query) => query.length > 0)
    .slice(0, RECENT_SEARCHES_SHOWN)
    .map((query) => ({
      kind: 'recent' as const,
      key: `recent:${query.toLowerCase()}`,
      label: query,
      query,
    }));

  const tagChips: SearchSuggestion[] = [...input.tagCounts]
    .map((tag) => ({ ...tag, name: tag.name.trim() }))
    .filter((tag) => tag.name.length > 0 && tag.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, SUGGESTION_TAGS_SHOWN)
    .map((tag) => ({
      kind: 'tag' as const,
      key: `tag:${tag.id}`,
      label: `#${tag.name}`,
      filter: { kind: 'tag' as const, id: tag.id },
    }));

  const folderChips: SearchSuggestion[] = [...input.folders]
    .map((folder) => ({ ...folder, name: folder.name.trim() }))
    .filter((folder) => folder.name.length > 0 && folder.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, SUGGESTION_FOLDERS_SHOWN)
    .map((folder) => ({
      kind: 'folder' as const,
      key: `folder:${folder.id}`,
      label: folder.name,
      filter: { kind: 'collection' as const, id: folder.id },
    }));

  return [...recentChips, ...tagChips, ...folderChips];
}

// Re-export the storage caps so callers reading this module see the full
// contract in one place (the recents engine owns the source of truth).
export { RECENT_SEARCHES_SHOWN, RECENT_SEARCHES_CAP };
