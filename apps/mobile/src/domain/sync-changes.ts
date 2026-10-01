import type { Bookmark, SyncChange, SyncChangeSource } from './types';

export const SYNC_CHANGE_SOURCES: readonly SyncChangeSource[] = [
  'capture', 'import', 'account_rehome', 'user_edit', 'metadata_fetch',
  'preview_refresh', 'ai_apply', 'suggestion_review', 'trash', 'restore',
  'delete', 'sync_recovery', 'sync_reconcile', 'unknown',
];
const LOCAL_FIELDS = new Set(['id', 'user_id', 'updated_at', 'sync_status', 'ever_synced',
  'title_is_derived', 'last_accessed_at', 'video_unavailable', 'local_image_uri', 'local_image_mime_type',
  'local_image_uploaded_for_user_id']);

/** Record actual field differences, including null/empty clears; never values. */
export function changedSyncFields(before: Bookmark, patch: Partial<Bookmark>): string[] {
  return Object.keys(patch).filter((key) => !LOCAL_FIELDS.has(key) &&
    JSON.stringify(before[key as keyof Bookmark]) !== JSON.stringify(patch[key as keyof Bookmark])).sort();
}

/** Bounded provenance of outstanding work, not an unlimited audit history. */
export function mergeSyncChanges(previous: readonly SyncChange[] | undefined, next: SyncChange): SyncChange[] {
  const entries = [...(previous ?? [])];
  const existing = entries.find((entry) => entry.source === next.source);
  if (existing) {
    return entries.map((entry) => entry.source === next.source
      ? { source: next.source, fields: [...new Set([...entry.fields, ...next.fields])].sort(), at: next.at }
      : { ...entry, fields: [...entry.fields] });
  }
  return [...entries, { ...next, fields: [...next.fields].sort() }];
}

export function parseSyncChanges(raw: string | null | undefined): SyncChange[] | undefined {
  if (!raw) return undefined;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return undefined;
    const result: SyncChange[] = [];
    for (const row of rows) {
      if (!row || !SYNC_CHANGE_SOURCES.includes(row.source) || !Array.isArray(row.fields) ||
        !row.fields.every((field: unknown) => typeof field === 'string') || typeof row.at !== 'string') continue;
      const next = mergeSyncChanges(result, { source: row.source, fields: row.fields, at: row.at });
      result.splice(0, result.length, ...next);
    }
    return result.length ? result : undefined;
  } catch { return undefined; }
}
