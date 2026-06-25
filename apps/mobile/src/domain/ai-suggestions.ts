/**
 * Centralized rules for surfacing AI tag suggestions.
 *
 * Both the Inbox "✨ N" badge and the Bookmark Detail "AI suggestions" card
 * compute their pending list from here, so the threshold and applied-name
 * filter live in exactly one place.
 */

import { collectionMatchKey } from './collection-match.ts';
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
 * The AI's folder (collection) recommendation for a bookmark, resolved against
 * the user's live collection list. Either an existing collection to *file into*
 * or a proposed name to *create*. `null` when there's nothing to suggest (no
 * hint, or the bookmark already lives in the suggested folder).
 */
export type SuggestedFolder =
  | { kind: 'existing'; id: string; name: string }
  | { kind: 'create'; name: string };

/**
 * Resolve the AI folder suggestion the same way the Detail screen does: prefer
 * the edge function's resolved `suggested_collection_id`, fall back to a tolerant
 * name match against the live collections (so a folder created since the
 * enrichment ran still counts as "file into" rather than a duplicate "create"),
 * and otherwise offer to create the proposed name. Returns `null` when the
 * bookmark already sits in the suggested collection or there's no hint at all.
 *
 * Pure so both the Review screen and tests can share one rule.
 */
export function resolveSuggestedFolder(
  enrichment: AIEnrichment | undefined | null,
  collections: ReadonlyArray<{ id: string; name: string }>,
  currentCollectionId: string | null,
): SuggestedFolder | null {
  if (!enrichment) {
    return null;
  }
  const suggestedByName = enrichment.suggested_collection_name?.trim() || null;
  const suggestedNameKey = suggestedByName ? collectionMatchKey(suggestedByName) : '';
  const byId = enrichment.suggested_collection_id
    ? collections.find((collection) => collection.id === enrichment.suggested_collection_id)
    : undefined;
  const byName = suggestedNameKey
    ? collections.find((collection) => collectionMatchKey(collection.name) === suggestedNameKey)
    : undefined;
  const existing = byId ?? byName;
  if (existing) {
    return existing.id === currentCollectionId
      ? null
      : { kind: 'existing', id: existing.id, name: existing.name };
  }
  return suggestedByName ? { kind: 'create', name: suggestedByName } : null;
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

/**
 * A stable token identifying the specific folder suggestion the user dismissed,
 * so the dismissal can be remembered durably (per bookmark) and *only that*
 * suggestion stays hidden. Filing into an existing collection is keyed by its id;
 * an offer to create a new folder by its tolerant match-key. A later enrichment
 * proposing a *different* collection or name yields a different token, so the
 * chip re-surfaces rather than staying suppressed forever.
 */
export function suggestedFolderToken(folder: SuggestedFolder): string {
  return folder.kind === 'existing' ? `id:${folder.id}` : `name:${collectionMatchKey(folder.name)}`;
}

/**
 * A per-bookmark record of folder-suggestion tokens (see
 * {@link suggestedFolderToken}) the user has dismissed, keyed by bookmark id.
 * Same JSON shape as {@link ReviewedSuggestionMap}, persisted under its own meta
 * key so a dismissed folder chip stays gone across remounts and relaunches —
 * unlike the prior session-only state, which re-surfaced on re-entering Detail.
 */
export type DismissedFolderMap = Record<string, string[]>;

/** Parse the JSON meta blob into a {@link DismissedFolderMap}, tolerating
 *  malformed/legacy values by returning an empty map. */
export function parseDismissedFolderMap(raw: string | null): DismissedFolderMap {
  return parseReviewedMap(raw);
}

/** The dismissed folder-suggestion tokens for one bookmark, as a Set. */
export function dismissedFolderTokensFor(map: DismissedFolderMap, bookmarkId: string): Set<string> {
  return new Set(map[bookmarkId] ?? []);
}

/**
 * Record `token` as a dismissed folder suggestion for `bookmarkId`. Returns the
 * SAME map reference when the token was already present (so callers can skip a
 * re-persist), otherwise a new map with the token merged in.
 */
export function addDismissedFolderToken(
  map: DismissedFolderMap,
  bookmarkId: string,
  token: string,
): DismissedFolderMap {
  const existing = map[bookmarkId] ?? [];
  if (existing.includes(token)) {
    return map;
  }
  return { ...map, [bookmarkId]: [...existing, token] };
}
