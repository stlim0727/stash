/**
 * Folder View's own sort order — separate from the bookmark-level `sort` in
 * `domain/sort.ts` (see `INBOX_SORT_PREF_KEY`). Folder View sorts Collection
 * *tiles*, not bookmarks, so the field union is different (name or item
 * count, not date/accessed) and the preference is persisted independently:
 * switching Folder View's order must not disturb what Card/List is sorted by,
 * and vice versa.
 *
 * There is deliberately no "recently active folder" option: `collections`
 * rows never get their `updated_at` bumped when a bookmark is filed into or
 * out of them (there's no rename/edit mutation for collections at all), so
 * that field never moves and would be a dead sort order.
 */
export type FolderSortField = 'name' | 'count';
export type FolderSortDir = 'asc' | 'desc';

export interface FolderSortOption {
  field: FolderSortField;
  dir: FolderSortDir;
}

/**
 * Name-ascending is the pre-existing hardcoded order Folder View shipped
 * with (PR #584) — keeping it the default means shipping the sort control
 * doesn't itself look like a surprise reordering.
 */
export const DEFAULT_FOLDER_SORT: FolderSortOption = { field: 'name', dir: 'asc' };

/** The orders the user can pick from, in menu order. */
export const FOLDER_SORT_PRESETS: FolderSortOption[] = [
  { field: 'name', dir: 'asc' }, // 이름 ㄱ–ㅎ
  { field: 'name', dir: 'desc' }, // 이름 ㅎ–ㄱ
  { field: 'count', dir: 'desc' }, // 항목 많은 순
  { field: 'count', dir: 'asc' }, // 항목 적은 순
];

/** Persistence key — disjoint from `INBOX_SORT_PREF_KEY` on purpose. */
export const FOLDER_SORT_PREF_KEY = 'pref.folder.sort';

export function sameFolderSort(a: FolderSortOption, b: FolderSortOption): boolean {
  return a.field === b.field && a.dir === b.dir;
}

/** The shape `sortFolderTiles` needs from whatever it's sorting. */
export interface FolderSortable {
  id: string;
  name: string;
  count: number;
}

function folderSortName(item: FolderSortable): string {
  return item.name.trim().toLocaleLowerCase();
}

function compareName(a: FolderSortable, b: FolderSortable): number {
  return folderSortName(a).localeCompare(folderSortName(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Return a new array sorted by the given option. Ties (equal name, or equal
 * count) always break by name-ascending, then id, so the order is stable and
 * deterministic regardless of input order.
 */
export function sortFolderTiles<T extends FolderSortable>(
  items: T[],
  option: FolderSortOption,
): T[] {
  const sign = option.dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const primary = option.field === 'count' ? sign * (a.count - b.count) : sign * compareName(a, b);
    if (primary !== 0) {
      return primary;
    }
    const byName = compareName(a, b);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

/** Short human label for the active order (used in the sort control + a11y). */
export function describeFolderSort(option: FolderSortOption): string {
  if (option.field === 'count') {
    return option.dir === 'desc' ? 'Most items' : 'Fewest items';
  }
  return option.dir === 'asc' ? 'Name A–Z' : 'Name Z–A';
}

/** Compact, forward-compatible serialization for persistence. */
export function serializeFolderSort(option: FolderSortOption): string {
  return `${option.field}:${option.dir}`;
}

export function parseFolderSort(raw: string | null | undefined): FolderSortOption {
  if (!raw) {
    return DEFAULT_FOLDER_SORT;
  }
  const [field, dir] = raw.split(':');
  if ((field === 'name' || field === 'count') && (dir === 'asc' || dir === 'desc')) {
    return { field, dir };
  }
  return DEFAULT_FOLDER_SORT;
}
