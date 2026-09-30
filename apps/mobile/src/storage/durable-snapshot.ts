import type { Bookmark } from '@/domain/types';

/** Read the persisted web snapshot directly, never the repository's memory fallback. */
export async function readDurableBookmarks(): Promise<Bookmark[] | null> {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem('stash.bookmarks');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object' && typeof item.id === 'string')
      ? parsed as Bookmark[] : null;
  } catch {
    return null;
  }
}
