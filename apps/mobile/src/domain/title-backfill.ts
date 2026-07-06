/**
 * One-time repair for bookmarks already saved with a poor URL-derived title.
 *
 * Improving `deriveMetadata` only helps *future* saves: an existing row is
 * already `metadata_status: 'complete'` (so it never re-enriches) and its bad
 * title was persisted as if it were real, so the fill-guards that protect
 * user-typed titles now also protect our own bad guess. This plans a safe
 * upgrade.
 *
 * Safety rests on one exact test: recompute what the *historical* fallback
 * would have produced for the URL, and only touch a row whose current title
 * equals it byte-for-byte. A title the user typed (or a real fetched title)
 * cannot match, so a rename is never clobbered — the guess is provably ours.
 */

// Relative .ts imports (not the @ alias) so Node's test runner can resolve it.
import { deriveMetadata } from './enrichment.ts';
import { youtubeVideoId } from './page-metadata.ts';
import type { Bookmark } from './types.ts';

/**
 * Reproduce the pre-upgrade fallback title exactly. This is frozen legacy logic
 * — it must keep matching what was historically written to storage, so it does
 * NOT share code with the evolving `deriveMetadata`/`titleCaseFromSlug`.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // a malformed percent-escape decodes to itself, never throws
  }
}

function legacyTitleCaseFromSlug(slug: string): string | null {
  const words = safeDecode(slug)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) {
    return null;
  }
  return words
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function legacyFallbackTitle(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  const title = lastSegment && !youtubeVideoId(rawUrl) ? legacyTitleCaseFromSlug(lastSegment) : host;
  return title ?? host;
}

export interface TitleBackfillPatch {
  /** The improved URL-derived label to write in place of the poor one. */
  title: string;
  /** Set only when a thumbnail is newly derivable and the row had none. */
  preview_image_url: string | null;
  /** Always true — a backfilled title is, by definition, a generated label. */
  title_is_derived: true;
}

/**
 * Plan an upgrade for one bookmark, or null when it should be left untouched.
 * Applies only when (a) the current title is provably the historical machine
 * fallback and (b) the new derivation actually improves it (a better title or a
 * newly-available thumbnail) — so a row that already reads well causes no churn.
 */
export function planTitleBackfill(bookmark: Bookmark): TitleBackfillPatch | null {
  const url = bookmark.url;
  if (!url || bookmark.title == null) {
    return null;
  }
  // Only settled rows. A `pending` row is either mid-enrichment (an in-flight
  // fetch whose snapshot still holds the current title, so clearing it here
  // would strand the row title-less) or a fresh add/import that may treat its
  // title as user-provided — leave both to the enrichment path.
  if (bookmark.metadata_status === 'pending') {
    return null;
  }
  // Authoritative provenance wins over the string match: a title recorded as
  // NOT derived (a real fetched title or a user rename) is never touched, even
  // if it happens to equal what the historical fallback would have produced.
  if (bookmark.title_is_derived === false) {
    return null;
  }
  const legacy = legacyFallbackTitle(url);
  if (legacy == null || bookmark.title !== legacy) {
    return null; // user-renamed or a real fetched title — not ours to change
  }
  const derived = deriveMetadata(url);
  if (derived.title == null) {
    return null;
  }
  const titleImproved = derived.title !== bookmark.title;
  const thumbAdded = derived.preview_image_url != null && bookmark.preview_image_url == null;
  if (!titleImproved && !thumbAdded) {
    return null; // nothing to gain
  }
  // A purely local cosmetic relabel: write the better URL-derived label (and any
  // derivable thumbnail) now, marked as a generated title. Deliberately does NOT
  // re-fetch — routing a synced row through enrichment would bump `updated_at`
  // and upload, which before the startup pull can overwrite a better remote
  // title. New saves still fetch normally; the `title_is_derived` flag leaves
  // these rows eligible for a future bounded retry.
  return {
    title: derived.title,
    preview_image_url: thumbAdded ? derived.preview_image_url : null,
    title_is_derived: true,
  };
}
