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
import { matchesQuery, type MatchRank } from '@/domain/search';
import { collectionMatchKey } from '@/domain/collection-match';

// Uncomposed Hangul jamo (lead consonant, vowel, trail) and compatibility jamo
// blocks. iOS/Android IME sends raw jamo to the TextInput while a Korean syllable
// is still being composed — NFKC does NOT decompose already-composed syllables
// to jamo, so a partial jamo query can never match composed-syllable candidates.
// When the query contains jamo, skip live filtering and fall back to the focus-
// empty (browse) shelf so the rail doesn't vanish mid-composition.
const JAMO_REGEX = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/u;

/** Visible cap on top tags surfaced in the shelf (by frequency, desc). */
export const SUGGESTION_TAGS_SHOWN = 8;
/** Visible cap on top folders surfaced in the shelf (by bookmark count, desc). */
export const SUGGESTION_FOLDERS_SHOWN = 8;
/**
 * Visible cap on matching recents WHILE TYPING (Phase 2, §13.3). Lower than the
 * empty-state {@link RECENT_SEARCHES_SHOWN} (6) so matched recents — the highest-
 * intent autocomplete — don't crowd out the tag/folder destinations.
 */
export const SUGGESTION_RECENTS_TYPING = 3;

/**
 * Order recents (their match rank) within a family while typing: exact first,
 * then prefix, then substring. A non-match sorts last (it's filtered out before
 * ranking, but the table keeps the comparator total).
 */
const RANK_ORDER: Record<MatchRank, number> = {
  exact: 0,
  prefix: 1,
  substring: 2,
  none: 3,
};

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
  const query = input.query?.trim() ?? '';
  // Treat a partial jamo query as not-yet-committed: IME is still composing, so
  // no candidate can match the decomposed jamo — fall back to the focus-empty
  // (browse) shelf so the rail doesn't vanish while the user is mid-syllable.
  const typing = query.length > 0 && !JAMO_REGEX.test(query);

  // ── Recents ──────────────────────────────────────────────────────────────
  // Empty query: keep the caller's recency order, cap at the empty-state count.
  // Typing (§13.3): keep only recents that MATCH the query, drop one that EQUALS
  // the query (you're already typing it — re-offering is noise), rank
  // exact→prefix→substring then recency, cap at the lower typing count.
  const trimmedRecents = input.recents
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0);
  let recentNames: string[];
  if (typing) {
    const queryNorm = collectionMatchKey(query);
    recentNames = trimmedRecents
      .map((name, index) => ({ name, index, rank: matchesQuery(name, query) }))
      .filter((entry) => entry.rank !== 'none' && collectionMatchKey(entry.name) !== queryNorm)
      // Recency order is the input order; rank tiers above it, recency breaks ties.
      .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.index - b.index)
      .slice(0, SUGGESTION_RECENTS_TYPING)
      .map((entry) => entry.name);
  } else {
    recentNames = trimmedRecents.slice(0, RECENT_SEARCHES_SHOWN);
  }
  const recentChips: SearchSuggestion[] = recentNames.map((name) => ({
    kind: 'recent' as const,
    key: `recent:${name.toLowerCase()}`,
    label: name,
    query: name,
  }));

  // ── Tags ─────────────────────────────────────────────────────────────────
  // Empty query: top tags by frequency desc (ties alpha). Typing: keep matching
  // tags, rank exact→prefix→substring then frequency desc then alpha.
  const tagChips: SearchSuggestion[] = rankFamily(
    input.tagCounts
      .map((tag) => ({ ...tag, name: tag.name.trim() }))
      .filter((tag) => tag.name.length > 0 && tag.count > 0),
    query,
    typing,
  )
    .slice(0, SUGGESTION_TAGS_SHOWN)
    .map((tag) => ({
      kind: 'tag' as const,
      key: `tag:${tag.id}`,
      label: `#${tag.name}`,
      filter: { kind: 'tag' as const, id: tag.id },
    }));

  // ── Folders ──────────────────────────────────────────────────────────────
  const folderChips: SearchSuggestion[] = rankFamily(
    input.folders
      .map((folder) => ({ ...folder, name: folder.name.trim() }))
      .filter((folder) => folder.name.length > 0 && folder.count > 0),
    query,
    typing,
  )
    .slice(0, SUGGESTION_FOLDERS_SHOWN)
    .map((folder) => ({
      kind: 'folder' as const,
      key: `folder:${folder.id}`,
      label: folder.name,
      filter: { kind: 'collection' as const, id: folder.id },
    }));

  // Cross-family order stays recents → tags → folders (no score interleave,
  // §13.3): the meaning of each family is more important to keep grouped than a
  // marginally higher cross-family score.
  return [...recentChips, ...tagChips, ...folderChips];
}

/** A named, count-bearing family member (a tag or a folder). */
interface RankableFamily {
  id: string;
  name: string;
  count: number;
}

/**
 * Order a tag/folder family. Empty query → frequency/count desc, ties alpha
 * (Phase-1). Typing → keep only matches, rank exact→prefix→substring, then the
 * count signal desc, then alpha (§13.3). The match predicate is the shared
 * `matchesQuery` so the shelf agrees with the results list.
 */
function rankFamily<T extends RankableFamily>(items: T[], query: string, typing: boolean): T[] {
  if (!typing) {
    return [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  return items
    .map((item) => ({ item, rank: matchesQuery(item.name, query) }))
    .filter((entry) => entry.rank !== 'none')
    .sort(
      (a, b) =>
        RANK_ORDER[a.rank] - RANK_ORDER[b.rank] ||
        b.item.count - a.item.count ||
        a.item.name.localeCompare(b.item.name),
    )
    .map((entry) => entry.item);
}

// Re-export the storage caps so callers reading this module see the full
// contract in one place (the recents engine owns the source of truth).
export { RECENT_SEARCHES_SHOWN, RECENT_SEARCHES_CAP };
