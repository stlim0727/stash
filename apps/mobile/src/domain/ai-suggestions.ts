/**
 * Centralized rules for surfacing AI tag suggestions.
 *
 * Both the Inbox "✨ N" badge and the Bookmark Detail "AI suggestions" card
 * compute their pending list from here, so the threshold and applied-name
 * filter live in exactly one place.
 */

import type { AIEnrichment, SuggestedTag } from './types';

/**
 * Minimum confidence (0..1) a suggested tag must reach before we surface it.
 * Below this we treat the suggestion as noise and hide it to reduce overload.
 */
export const SUGGESTION_MIN_CONFIDENCE = 0.6;

/**
 * Suggested tags worth showing for a bookmark: not already applied
 * (case-insensitive by name), not already reviewed by the user, AND at/above
 * {@link SUGGESTION_MIN_CONFIDENCE}.
 *
 * `reviewedNames` is the set of suggestion names the user has already acted on
 * (accepted or dismissed). It is what makes the "✨ N" badge mean *unreviewed*
 * suggestions rather than *un-applied* ones — so accepting a suggested tag and
 * later removing it does not bring the badge back (the name stays reviewed).
 *
 * Pure and side-effect free so it can be unit-tested and reused across screens.
 */
export function pendingSuggestions(
  enrichment: AIEnrichment | undefined | null,
  appliedTagNames: Set<string>,
  reviewedNames?: Set<string>,
): SuggestedTag[] {
  return (enrichment?.suggested_tags ?? []).filter((suggestion) => {
    const name = suggestion.name.toLowerCase();
    return (
      !appliedTagNames.has(name) &&
      !(reviewedNames?.has(name) ?? false) &&
      suggestion.confidence >= SUGGESTION_MIN_CONFIDENCE
    );
  });
}

/**
 * A per-bookmark record of suggestion names the user has already reviewed
 * (accepted or dismissed), keyed by bookmark id. Names are stored lowercased
 * and deduped. Persisted as JSON in the repository meta store.
 */
export type ReviewedSuggestionMap = Record<string, string[]>;

/** Parse the JSON meta blob into a {@link ReviewedSuggestionMap}, tolerating
 *  malformed/legacy values by returning an empty map. */
export function parseReviewedMap(raw: string | null): ReviewedSuggestionMap {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: ReviewedSuggestionMap = {};
    for (const [bookmarkId, names] of Object.entries(parsed)) {
      if (Array.isArray(names)) {
        result[bookmarkId] = names.filter((name): name is string => typeof name === 'string');
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** The reviewed suggestion names for one bookmark, lowercased, as a Set. */
export function reviewedNamesFor(map: ReviewedSuggestionMap, bookmarkId: string): Set<string> {
  return new Set((map[bookmarkId] ?? []).map((name) => name.toLowerCase()));
}

/**
 * Record `names` as reviewed for `bookmarkId`. Returns the SAME map reference
 * when nothing new was added (so callers can skip a re-persist), otherwise a
 * new map with the names merged in (lowercased, trimmed, deduped).
 */
export function addReviewedNames(
  map: ReviewedSuggestionMap,
  bookmarkId: string,
  names: string[],
): ReviewedSuggestionMap {
  const existing = map[bookmarkId] ?? [];
  const merged = new Set(existing);
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    if (normalized) {
      merged.add(normalized);
    }
  }
  if (merged.size === existing.length) {
    return map;
  }
  return { ...map, [bookmarkId]: [...merged] };
}
