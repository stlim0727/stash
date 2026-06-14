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
 * (case-insensitive by name) AND at/above {@link SUGGESTION_MIN_CONFIDENCE}.
 *
 * Pure and side-effect free so it can be unit-tested and reused across screens.
 */
export function pendingSuggestions(
  enrichment: AIEnrichment | undefined | null,
  appliedTagNames: Set<string>,
): SuggestedTag[] {
  return (enrichment?.suggested_tags ?? []).filter(
    (suggestion) =>
      !appliedTagNames.has(suggestion.name.toLowerCase()) &&
      suggestion.confidence >= SUGGESTION_MIN_CONFIDENCE,
  );
}
