import type { TagData } from '@/storage/types';

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Strip tag/collection rows whose name is empty or whitespace, plus any
 * bookmark-tag links orphaned by removing those tags. Such rows render as blank
 * pills in the Browse shelf and are never useful; they can arrive from a legacy
 * client, a partial sync, or the server. Returns the original object unchanged
 * (same reference) when there is nothing to clean, so callers can cheaply skip
 * re-persisting.
 */
export function sanitizeTagData(data: TagData): { tagData: TagData; changed: boolean } {
  const tags = data.tags.filter((tag) => !isBlank(tag.name));
  const collections = data.collections.filter((collection) => !isBlank(collection.name));
  const validTagIds = new Set(tags.map((tag) => tag.id));
  const bookmarkTags = data.bookmarkTags.filter((link) => validTagIds.has(link.tag_id));

  const changed =
    tags.length !== data.tags.length ||
    collections.length !== data.collections.length ||
    bookmarkTags.length !== data.bookmarkTags.length;

  return { tagData: changed ? { tags, bookmarkTags, collections } : data, changed };
}
