/** Durable collection assignments created by bookmark imports. */

export const PENDING_IMPORT_COLLECTIONS_KEY = 'pending_import_collections';

export interface PendingImportCollection {
  bookmark_id: string;
  collection_name: string;
  status: 'pending' | 'failed';
  last_error: string | null;
  created_at: string;
}

export function parsePendingImportCollections(raw: string | null): PendingImportCollection[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is PendingImportCollection =>
            !!item &&
            typeof item.bookmark_id === 'string' &&
            typeof item.collection_name === 'string' &&
            (item.status === 'pending' || item.status === 'failed'),
        )
      : [];
  } catch {
    return [];
  }
}

export function enqueuePendingImportCollection(
  pending: PendingImportCollection[],
  next: PendingImportCollection,
): PendingImportCollection[] {
  return [
    ...pending.filter((item) => item.bookmark_id !== next.bookmark_id),
    next,
  ];
}

export function rekeyPendingImportCollections(
  pending: PendingImportCollection[],
  idMap: Map<string, string>,
): PendingImportCollection[] {
  return pending.map((item) => ({
    ...item,
    bookmark_id: idMap.get(item.bookmark_id) ?? item.bookmark_id,
  }));
}

export function dropPendingImportCollections(
  pending: PendingImportCollection[],
  bookmarkIds: readonly string[],
): PendingImportCollection[] {
  const dropped = new Set(bookmarkIds);
  return pending.filter((item) => !dropped.has(item.bookmark_id));
}
