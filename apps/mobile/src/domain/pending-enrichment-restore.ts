/**
 * Durable outbox for restoring a Stash JSON backup's AI enrichment snapshot
 * (#671). Mirrors src/domain/pending-import-collections.ts: an entry is
 * enqueued locally the moment a `stash-backup` import item carries an
 * `enrichment` snapshot, keyed by the *local* bookmark id so it survives app
 * termination before that bookmark has a confirmed remote id. Once the
 * bookmark's create/dedupe-adopt upload resolves, the entry is rekeyed to the
 * remote id (same seam as `rekeyPendingImportCollections`) so the eventual
 * upload targets the bookmark Supabase actually knows about, then dropped once
 * that upload is durably confirmed.
 *
 * This module only defines the queue's shape and pure transitions. Wiring it
 * into the sync loop (drive/upload, retry, rekey call sites) is a follow-up —
 * see #671.
 */

import type { ImportedEnrichment } from '@/domain/import';

export const PENDING_ENRICHMENT_RESTORE_KEY = 'pending_enrichment_restore';

export interface PendingEnrichmentRestore {
  bookmark_id: string;
  enrichment: ImportedEnrichment;
  status: 'pending' | 'failed';
  last_error: string | null;
  created_at: string;
}

function isImportedEnrichment(value: unknown): value is ImportedEnrichment {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.topics) && Array.isArray(candidate.suggested_tags);
}

function isPendingEnrichmentRestore(value: unknown): value is PendingEnrichmentRestore {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.bookmark_id === 'string' &&
    (candidate.status === 'pending' || candidate.status === 'failed') &&
    isImportedEnrichment(candidate.enrichment)
  );
}

export function parsePendingEnrichmentRestores(raw: string | null): PendingEnrichmentRestore[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingEnrichmentRestore) : [];
  } catch {
    return [];
  }
}

/** One entry per bookmark — a later enqueue for the same id supersedes the earlier one. */
export function enqueuePendingEnrichmentRestore(
  pending: PendingEnrichmentRestore[],
  next: PendingEnrichmentRestore,
): PendingEnrichmentRestore[] {
  return [...pending.filter((item) => item.bookmark_id !== next.bookmark_id), next];
}

/** Re-key entries from a local id to its resolved remote id (dedupe-adopt, anon-to-real). */
export function rekeyPendingEnrichmentRestores(
  pending: PendingEnrichmentRestore[],
  idMap: Map<string, string>,
): PendingEnrichmentRestore[] {
  return pending.map((item) => ({
    ...item,
    bookmark_id: idMap.get(item.bookmark_id) ?? item.bookmark_id,
  }));
}

export function dropPendingEnrichmentRestores(
  pending: PendingEnrichmentRestore[],
  bookmarkIds: readonly string[],
): PendingEnrichmentRestore[] {
  const dropped = new Set(bookmarkIds);
  return pending.filter((item) => !dropped.has(item.bookmark_id));
}
