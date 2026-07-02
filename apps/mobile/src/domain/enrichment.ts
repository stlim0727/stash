// Relative .ts import (not the @ alias) so Node's test runner can resolve it.
import { fetchPageMetadata, youtubeVideoId } from './page-metadata.ts';
import type { FetchedMetadata } from './page-metadata.ts';
import type { Bookmark, MetadataStatus } from '@/domain/types';

/**
 * Generated (non-user-authored) metadata fields. Keeping this set explicit
 * ensures enrichment never touches user-owned fields like `notes` or a title
 * the user typed themselves.
 */
export interface DerivedMetadata {
  title: string | null;
  site_name: string | null;
  favicon_url: string | null;
  preview_image_url: string | null;
}

function titleCaseFromSlug(slug: string): string | null {
  const words = decodeURIComponent(slug)
    .replace(/\.[a-z0-9]+$/i, '') // drop a trailing file extension
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

/**
 * Best-effort metadata derived purely from the URL — no network, so it is
 * deterministic and safe to run anywhere. A real implementation would fetch
 * the page and parse OpenGraph/Twitter tags here; the return shape stays the
 * same so it can drop in without touching callers.
 */
export function deriveMetadata(rawUrl: string): DerivedMetadata {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, '');

  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  // A YouTube video's identifying path/query segment is an opaque id (e.g.
  // `LNysDlsp26Q` for `youtu.be/LNysDlsp26Q`, or the bare `watch` path for a
  // `?v=` link) — as a title it reads like a random/"encrypted" string, not a
  // name. When the real title can't be fetched (oEmbed and HTML both failed),
  // the host is a far better fallback than that id.
  const title =
    lastSegment && !youtubeVideoId(rawUrl) ? titleCaseFromSlug(lastSegment) : host;

  return {
    title: title ?? host,
    site_name: host,
    favicon_url: `${url.origin}/favicon.ico`,
    preview_image_url: null,
  };
}

/** The generated patch plus the resulting status, ready to merge onto a bookmark. */
export interface EnrichmentResult {
  patch: Partial<Bookmark>;
  metadata_status: MetadataStatus;
}

export type MetadataFetcher = (url: string) => Promise<FetchedMetadata | null>;

/**
 * Produces an enrichment patch for a bookmark. Only fills generated fields
 * that are still empty, so a user-provided title/description is never
 * overwritten. Real page metadata (OpenGraph/title/favicon) is preferred;
 * URL-derived values fill whatever the fetch could not provide, so a dead
 * network still yields usable metadata. Resolves to a `failed` status on any
 * error rather than throwing, so enrichment can never break the save path.
 */
export async function enrichBookmark(
  bookmark: Bookmark,
  fetchMetadata: MetadataFetcher = fetchPageMetadata,
): Promise<EnrichmentResult> {
  if (!bookmark.url) {
    // Nothing to derive from a text-only share; mark as skipped.
    return { patch: {}, metadata_status: 'skipped' };
  }

  try {
    const fetched = (await fetchMetadata(bookmark.url).catch(() => null)) ?? {};
    const fallback = deriveMetadata(bookmark.url);
    const derived: DerivedMetadata = {
      title: fetched.title ?? fallback.title,
      site_name: fetched.site_name ?? fallback.site_name,
      favicon_url: fetched.favicon_url ?? fallback.favicon_url,
      preview_image_url: fetched.preview_image_url ?? fallback.preview_image_url,
    };
    const patch: Partial<Bookmark> = {};
    if (bookmark.title == null) {
      patch.title = derived.title;
    }
    if (bookmark.site_name == null) {
      patch.site_name = derived.site_name;
    }
    if (bookmark.favicon_url == null) {
      patch.favicon_url = derived.favicon_url;
    }
    if (bookmark.preview_image_url == null && derived.preview_image_url != null) {
      patch.preview_image_url = derived.preview_image_url;
    }
    return { patch, metadata_status: 'complete' };
  } catch {
    return { patch: {}, metadata_status: 'failed' };
  }
}
