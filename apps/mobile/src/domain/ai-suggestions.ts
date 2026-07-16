/**
 * Centralized rules for surfacing AI tag suggestions.
 *
 * Both the Inbox "✨ N" badge and the Bookmark Detail "AI suggestions" card
 * compute their pending list from here, so the threshold and applied-name
 * filter live in exactly one place.
 */

import { collectionMatchKey } from './collection-match.ts';
import { addToStringSet, parseStringSetMap, stringSetFor } from './string-set-map.ts';
import type { StringSetMap } from './string-set-map.ts';
import type { AIEnrichment, MetadataStatus, SuggestedTag } from './types';

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
 *
 * `from` carries the collection the bookmark *currently* lives in, when it has
 * one — so the UI can tell an **add** (no `from`: file an un-filed bookmark in)
 * apart from a **change/move** (`from` set: relocate it out of `from` into the
 * suggestion), and render the move as `from → name`. `from` never participates
 * in the dismissal token ({@link suggestedFolderToken}) — a suggestion is the
 * same recommendation regardless of where the bookmark sits now.
 */
export type SuggestedFolder =
  | { kind: 'existing'; id: string; name: string; from?: { id: string; name: string } | null }
  | { kind: 'create'; name: string; from?: { id: string; name: string } | null };

/**
 * Resolve the AI folder suggestion the same way the Detail screen does: prefer
 * the edge function's resolved `suggested_collection_id`, fall back to a tolerant
 * name match against the live collections (so a folder created since the
 * enrichment ran still counts as "file into" rather than a duplicate "create"),
 * and otherwise offer to create the proposed name. Returns `null` when the
 * bookmark already sits in the suggested collection or there's no hint at all.
 *
 * When the bookmark currently lives in a *different* collection, the result
 * carries `from` (that collection's id+name) so the caller can render a move;
 * an unknown `currentCollectionId` (not in `collections`) yields `from: null`
 * (render as a plain add, never invent a name).
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
  // The collection the bookmark sits in now (if any, and if known) — attached as
  // `from` so an existing/create suggestion reads as a move rather than an add.
  const fromCollection = currentCollectionId
    ? (collections.find((collection) => collection.id === currentCollectionId) ?? null)
    : null;
  const from = fromCollection ? { id: fromCollection.id, name: fromCollection.name } : null;
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
      : { kind: 'existing', id: existing.id, name: existing.name, from };
  }
  return suggestedByName ? { kind: 'create', name: suggestedByName, from } : null;
}

/**
 * A per-bookmark record of suggestion names the user has already reviewed
 * (accepted or dismissed), keyed by bookmark id. Names are stored lowercased
 * and deduped. Persisted as JSON in the repository meta store. A
 * {@link StringSetMap} — see that module for the shared parse/merge machinery.
 */
export type ReviewedSuggestionMap = StringSetMap;

/** Parse the JSON meta blob into a {@link ReviewedSuggestionMap}, tolerating
 *  malformed/legacy values by returning an empty map. */
export function parseReviewedMap(raw: string | null): ReviewedSuggestionMap {
  return parseStringSetMap(raw);
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
  return addToStringSet(map, bookmarkId, names, (name) => name.trim().toLowerCase());
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
 * Every token that identifies one folder suggestion: the resolved form's token
 * plus the AI's proposed-name key. The *same* recommendation can render as a
 * "create {name}" chip or a "file into {existing}" chip depending on whether a
 * matching collection exists yet — and can flip between them after the user
 * dismisses it (a like-named folder is created/pulled later, or a matched one is
 * deleted). Recording every applicable token on dismiss, and treating the
 * suggestion as dismissed if *any* of them was recorded, keeps the dismissal
 * stable across that flip. `suggestedName` is the enrichment's raw
 * `suggested_collection_name`.
 */
export function suggestedFolderTokens(
  folder: SuggestedFolder | null,
  suggestedName: string | null | undefined,
): string[] {
  const tokens: string[] = [];
  if (folder) {
    tokens.push(suggestedFolderToken(folder));
  }
  const name = suggestedName?.trim();
  if (name) {
    const nameToken = suggestedFolderToken({ kind: 'create', name });
    if (!tokens.includes(nameToken)) {
      tokens.push(nameToken);
    }
  }
  return tokens;
}

/**
 * The folder suggestion to surface for a bookmark *after* honoring the user's
 * durable dismissals — {@link resolveSuggestedFolder} minus anything dismissed
 * (by any of its {@link suggestedFolderTokens}). This is the single predicate
 * every surface should use (Detail, Review, the Inbox badge/banner, Settings,
 * and the store's unseen-marker logic) so a folder dismissed on one screen stops
 * counting everywhere. Returns `null` when there's nothing to surface.
 */
export function pendingSuggestedFolder(
  enrichment: AIEnrichment | undefined | null,
  collections: ReadonlyArray<{ id: string; name: string }>,
  currentCollectionId: string | null,
  dismissedTokens?: ReadonlySet<string>,
): SuggestedFolder | null {
  const folder = resolveSuggestedFolder(enrichment, collections, currentCollectionId);
  if (!folder) {
    return null;
  }
  if (dismissedTokens && dismissedTokens.size > 0) {
    const tokens = suggestedFolderTokens(folder, enrichment?.suggested_collection_name);
    if (tokens.some((token) => dismissedTokens.has(token))) {
      return null;
    }
  }
  return folder;
}

/**
 * A per-bookmark record of folder-suggestion tokens (see
 * {@link suggestedFolderToken}) the user has dismissed, keyed by bookmark id.
 * Same shape and machinery as {@link ReviewedSuggestionMap} (both are
 * {@link StringSetMap}s), persisted under its own meta key so a dismissed folder
 * chip stays gone across remounts and relaunches — unlike the prior session-only
 * state, which re-surfaced on re-entering Detail. Tokens arrive pre-folded, so
 * unlike reviewed names they are stored verbatim (no extra normalization).
 */
export type DismissedFolderMap = StringSetMap;

/** Parse the JSON meta blob into a {@link DismissedFolderMap}, tolerating
 *  malformed/legacy values by returning an empty map. */
export function parseDismissedFolderMap(raw: string | null): DismissedFolderMap {
  return parseStringSetMap(raw);
}

/** The dismissed folder-suggestion tokens for one bookmark, as a Set. */
export function dismissedFolderTokensFor(map: DismissedFolderMap, bookmarkId: string): Set<string> {
  return stringSetFor(map, bookmarkId);
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
  return addToStringSet(map, bookmarkId, [token]);
}

/**
 * A stable token identifying a specific AI summary, so a user's decision to use
 * it or dismiss it can be remembered durably (per bookmark) and *only that*
 * summary stays hidden. Derived from the summary's normalized text (trimmed,
 * whitespace-collapsed, lowercased) hashed to a short string, so an identical
 * re-pull of the same summary stays quiet while a genuinely *new* summary from a
 * later enrichment yields a different token and re-surfaces. Returns null for an
 * empty/whitespace-only summary (nothing to review). djb2 is deterministic and
 * platform-free — the same summary text always maps to the same token on every
 * device, which is what makes the reviewed state portable across a re-pull.
 */
export function summaryToken(summary: string | null | undefined): string | null {
  const normalized = (summary ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized === '') {
    return null;
  }
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    // djb2: hash * 33 + char, kept in 32-bit unsigned range.
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return `s:${hash.toString(36)}`;
}

/**
 * A per-bookmark record of AI-summary tokens (see {@link summaryToken}) the user
 * has reviewed (used as a note or dismissed), keyed by bookmark id. Same shape
 * and machinery as {@link DismissedFolderMap} (both are {@link StringSetMap}s),
 * persisted under its own meta key so a summary the user acted on stays gone
 * across remounts and relaunches. Tokens arrive pre-hashed, so they are stored
 * verbatim (no extra normalization).
 */
export type ReviewedSummaryMap = StringSetMap;

/** Parse the JSON meta blob into a {@link ReviewedSummaryMap}, tolerating
 *  malformed/legacy values by returning an empty map. */
export function parseReviewedSummaryMap(raw: string | null): ReviewedSummaryMap {
  return parseStringSetMap(raw);
}

/** The reviewed summary tokens for one bookmark, as a Set. */
export function reviewedSummaryTokensFor(map: ReviewedSummaryMap, bookmarkId: string): Set<string> {
  return stringSetFor(map, bookmarkId);
}

/**
 * Record `token` as a reviewed summary for `bookmarkId`. Returns the SAME map
 * reference when the token was already present (so callers can skip a
 * re-persist), otherwise a new map with the token merged in.
 */
export function addReviewedSummaryToken(
  map: ReviewedSummaryMap,
  bookmarkId: string,
  token: string,
): ReviewedSummaryMap {
  return addToStringSet(map, bookmarkId, [token]);
}

/**
 * The AI summary worth offering as a proposed note for a bookmark, honoring
 * the same eligibility rule as the Detail screen's ProposedSummary widget: a
 * failed preview, an already-reviewed token, or the dummy-v0 heuristic
 * fallback (whose boilerplate text would leak the internal model name) never
 * qualify. Centralized so Review and the Inbox badge/banner agree with Detail
 * on when a summary still counts as "pending" — bundles the token alongside
 * the text since callers that offer accept/dismiss need both. Returns `null`
 * when there's nothing to surface.
 */
export function pendingSummary(
  metadataStatus: MetadataStatus,
  enrichment: AIEnrichment | undefined | null,
  reviewedTokens: ReadonlySet<string>,
): { text: string; token: string } | null {
  if (metadataStatus === 'failed' || enrichment?.model === 'dummy-v0') {
    return null;
  }
  const text = enrichment?.summary?.trim();
  if (!text) {
    return null;
  }
  const token = summaryToken(text);
  if (!token || reviewedTokens.has(token)) {
    return null;
  }
  return { text, token };
}
