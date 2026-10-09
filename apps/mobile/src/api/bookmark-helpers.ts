import { type ListBookmarksParams, type PostgrestSort, type RemoteAIEnrichment, type RemoteBookmark } from '@/api/bookmark-types';
import { isContentType } from '@/domain/import';
import { normalizeText, slugify } from '@/domain/tag-normalize';
import type {
  AIEnrichment,
  Bookmark,
  CreateBookmarkInput,
  SuggestedTag
} from '@/domain/types';
import { normalizeUrl } from '@/domain/urls';

// Thrown by `updateBookmark` when the PATCH (scoped to `id` + the current
// user's `user_id`) matches zero rows — the bookmark was deleted (on this
// device or another) or never belonged to this user. Exported so sync can
// recognize this exact, unambiguous case and reconcile instead of retrying
// an edit that can never land (see `sync/sync-bookmarks.ts`).
export const BOOKMARK_NOT_FOUND_ERROR_MESSAGE = 'Bookmark not found or not owned by the current user.';

export const DEFAULT_PAGE_SIZE = 50;

export const MAX_PAGE_SIZE = 100;

export function nowIso(): string {
  return new Date().toISOString();
}

export function uniqueNormalizedTags(tags: string[]): Array<{ name: string; slug: string }> {
  const seen = new Set<string>();
  const normalized: Array<{ name: string; slug: string }> = [];

  for (const tag of tags) {
    const name = normalizeText(tag);
    const slug = slugify(name);
    if (!name || !slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    normalized.push({ name, slug });
  }

  return normalized;
}

export function requirePayload(input: CreateBookmarkInput): { url: string | null; contentType: Bookmark['content_type'] } {
  if (input.url) {
    const normalized = normalizeUrl(input.url);
    if (!normalized) {
      throw new Error('createBookmark requires a valid URL when url is provided.');
    }

    const contentType: Bookmark['content_type'] =
      input.content_type && isContentType(input.content_type)
        ? input.content_type === 'image' && !input.preview_image_url?.trim()
          ? 'url'
          : input.content_type
        : 'url';
    return { url: normalized, contentType };
  }

  if (input.shared_text?.trim()) {
    return { url: null, contentType: 'text' };
  }

  // A restored text memo can legitimately have no body while retaining a
  // title, notes, tags, or collection. Its explicit type is enough to create
  // the row; manual Add still validates that newly-authored memos have a body.
  if (input.content_type === 'text') {
    return { url: null, contentType: 'text' };
  }

  // Image-only capture (a screenshot with no link): the client always
  // uploads the binary to Storage and resolves its public URL BEFORE calling
  // createBookmark, so this branch only ever sees an already-uploaded row —
  // requiring preview_image_url here (rather than trusting content_type
  // alone) is what stops a bookmark from ever being created server-side
  // before its image binary has genuinely landed (STASH-65 invariant).
  if (input.content_type === 'image' && input.preview_image_url?.trim()) {
    return { url: null, contentType: 'image' };
  }

  throw new Error('createBookmark requires either url, shared_text, or an uploaded image.');
}

export function remoteToBookmark(row: RemoteBookmark): Bookmark {
  return { ...row, sync_status: 'synced', ever_synced: true };
}

// Validate emptiness with a trimmed copy, but keep the original value —
// leading/trailing whitespace can be meaningful Markdown (e.g. an indented
// code block), so a memo body must not be silently rewritten on upload.
export function descriptionFromInput(input: {
  description?: string | null;
  shared_text?: string;
}): string | null {
  if (input.description?.trim()) {
    return input.description;
  }
  if (input.shared_text?.trim()) {
    return input.shared_text;
  }
  return null;
}

export function enrichmentFromRemote(row: RemoteAIEnrichment): AIEnrichment {
  return {
    ...row,
    topics: Array.isArray(row.topics) ? (row.topics as string[]) : [],
    suggested_tags: Array.isArray(row.suggested_tags)
      ? (row.suggested_tags as SuggestedTag[])
      : [],
    // Tolerate pre-M12 rows (and any backend without the columns yet): absent →
    // not degraded. The column defaults to false server-side, but the mapper
    // stays defensive so a missing field can never read as `undefined`.
    degraded: row.degraded === true,
    degraded_reason: row.degraded ? row.degraded_reason ?? null : null,
    // Tolerate rows from before the column existed: absent → no new-collection
    // suggestion. (RemoteAIEnrichment spreads the column through; this just
    // guarantees null over undefined.)
    suggested_collection_name: row.suggested_collection_name ?? null,
  };
}

export function inFilter(values: string[]): string {
  // Escape backslashes first, then quotes — otherwise a trailing `\` combines
  // with our injected `\"` and lets the value break out of its own quote.
  return `(${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')})`;
}

export function sortParam(sort: ListBookmarksParams['sort']): PostgrestSort {
  switch (sort) {
    case 'created_at_asc':
      return 'created_at.asc';
    case 'updated_at_asc':
      return 'updated_at.asc';
    case 'updated_at_desc':
      return 'updated_at.desc';
    case 'created_at_desc':
    default:
      return 'created_at.desc';
  }
}

export function appendSearchParams(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function bulkCreateKey(item: { urlHash: string | null; clientId: string | null }): string | null {
  if (item.urlHash) {
    return `url:${item.urlHash}`;
  }
  if (item.clientId) {
    return `client:${item.clientId}`;
  }
  return null;
}

/**
 * AI enrichment request timeout: The edge function's Gemini provider has a 15s timeout
 * before falling back to heuristics (supabase/functions/ai-enrich/gemini-provider.ts).
 * 35s ensures the client does not abort prematurely before the edge function can catch
 * the timeout and return its heuristic fallback.
 */
export const AI_ENRICH_REQUEST_TIMEOUT_MS = 35_000;
