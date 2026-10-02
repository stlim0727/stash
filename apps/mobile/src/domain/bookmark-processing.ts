import type { AIEnrichment, Bookmark, LocalPendingBookmark, SyncChange } from './types';
import type { AiServerQueueSnapshot } from './processing-status';

export type BookmarkSyncPhase =
  | 'local_only' | 'not_synced' | 'synced' | 'queued' | 'syncing'
  | 'interrupted' | 'failed' | 'inconsistent';
export type SyncBlocker = 'paused' | 'auth_unavailable' | 'retry_backoff' | 'permanent_error';

/** A content-free observation of this device, not a claim about live server state. */
export interface BookmarkProcessingSnapshot {
  bookmarkId: string;
  observedAt: string;
  sync: {
    phase: BookmarkSyncPhase;
    blockers: SyncBlocker[];
    bookmarkStatus: Bookmark['sync_status'];
    everSynced: boolean;
    authStatus: string;
    paused: boolean;
    serviceRunning: boolean;
    lastPulledAt: string | null;
    bookmarkUpdatedAt: string;
    queue: {
      operation: LocalPendingBookmark['operation'];
      changes: SyncChange[];
      status: LocalPendingBookmark['sync_status'];
      uploadFields: string[];
      retries: number;
      errorKind: string | null;
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
      lastAttemptAt: string | null;
      retryEligibleAt: string | null;
    } | null;
  };
  metadata: { status: Bookmark['metadata_status']; refreshing: boolean; titleIsDerived: boolean };
  organization: {
    tagUploads: { operation: 'add' | 'remove'; source: string; confirmed: boolean; retries: number; errorKind: string | null }[];
    importFolderPending: boolean;
  };
  ai: {
    waitingForSync: boolean;
    triggerPending: boolean;
    dispatchPending: boolean;
    inFlight: boolean;
    retry: { attempts: number; lastAttemptAt: string; eligibleAt: string | null } | null;
    locallyConfirmedServerQueued: boolean;
    serverQueue: AiServerQueueSnapshot | null;
    serverQueueObserved: boolean;
    mode: string;
    quota: { reason: string; retryAt: number } | null;
    result: {
      status: AIEnrichment['status'];
      model: string | null;
      confidence: number | null;
      hasSummary: boolean;
      suggestedTagCount: number;
      hasFolderSuggestion: boolean;
      degradedReason: string | null;
      updatedAt: string;
    } | null;
  };
}

export interface BookmarkProcessingInput {
  bookmark: Bookmark;
  queue?: LocalPendingBookmark;
  localOnly: boolean;
  syncedOnce: boolean;
  authStatus: string;
  hasSession: boolean;
  syncPaused: boolean;
  isSyncing: boolean;
  lastPulledAt: string | null;
  retryEligibleAt: number | null;
  permanentlyUnsyncable: boolean;
  refreshing: boolean;
  triggerPending: boolean;
  dispatchPending: boolean;
  inFlight: boolean;
  aiRetry: { attemptCount: number; lastAttemptAt: string; eligibleAt: number } | null;
  confirmedServerQueued: boolean;
  serverQueue: AiServerQueueSnapshot | null;
  serverQueueObserved: boolean;
  aiMode: string;
  quota: { reason: string; retryAt: number } | null;
  enrichment?: AIEnrichment;
  tagUploads?: BookmarkProcessingSnapshot['organization']['tagUploads'];
  importFolderPending?: boolean;
  now: number;
}

export function buildBookmarkProcessingSnapshot(input: BookmarkProcessingInput): BookmarkProcessingSnapshot {
  const { bookmark: b, queue: q, enrichment: e } = input;
  // The outbox wins over the bookmark mirror, including the inverse mismatch.
  const phase: BookmarkSyncPhase = input.localOnly ? 'local_only'
    : q?.sync_status === 'synced' ? 'inconsistent'
    : q?.sync_status === 'failed' ? 'failed'
    : q?.sync_status === 'syncing' ? (input.isSyncing ? 'syncing' : 'interrupted')
    : q ? 'queued'
    : b.sync_status !== 'synced' ? 'inconsistent'
    : input.syncedOnce ? 'synced' : 'not_synced';
  const blockers: SyncBlocker[] = [];
  if (phase !== 'local_only' && phase !== 'synced') {
    if (input.syncPaused) blockers.push('paused');
    if (!input.hasSession) blockers.push('auth_unavailable');
    if (input.permanentlyUnsyncable) blockers.push('permanent_error');
    if (input.retryEligibleAt !== null && input.retryEligibleAt > input.now) blockers.push('retry_backoff');
  }
  return {
    bookmarkId: b.id,
    observedAt: new Date(input.now).toISOString(),
    sync: {
      phase, blockers, bookmarkStatus: b.sync_status, everSynced: input.syncedOnce,
      authStatus: input.authStatus, paused: input.syncPaused, serviceRunning: input.isSyncing,
      lastPulledAt: input.lastPulledAt, bookmarkUpdatedAt: b.updated_at,
      queue: q ? {
        operation: q.operation, status: q.sync_status,
        changes: (q.changes ?? [{ source: 'unknown', fields: [], at: q.created_at }])
          .map((change) => ({ ...change, fields: [...change.fields] })),
        // Field names are clues, not a diff: omission can mean clearing a field.
        uploadFields: Object.keys(q.payload).sort(), retries: q.retry_count,
        errorKind: q.last_error_kind ?? null,
        lastError: q.last_error?.replace(/https?:\/\/[^\s"')]+/gi, '[URL]')
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300) ?? null,
        createdAt: q.created_at, updatedAt: q.updated_at,
        lastAttemptAt: q.last_attempt_at ?? null,
        retryEligibleAt: input.retryEligibleAt === null ? null : new Date(input.retryEligibleAt).toISOString(),
      } : null,
    },
    metadata: { status: b.metadata_status, refreshing: input.refreshing, titleIsDerived: b.title_is_derived === true },
    organization: {
      tagUploads: (input.tagUploads ?? []).map((item) => ({ ...item })),
      importFolderPending: input.importFolderPending === true,
    },
    ai: {
      waitingForSync: input.aiRetry?.attemptCount === 0,
      triggerPending: input.triggerPending, dispatchPending: input.dispatchPending, inFlight: input.inFlight,
      retry: input.aiRetry ? {
        attempts: input.aiRetry.attemptCount, lastAttemptAt: input.aiRetry.lastAttemptAt,
        eligibleAt: Number.isFinite(input.aiRetry.eligibleAt) ? new Date(input.aiRetry.eligibleAt).toISOString() : null,
      } : null,
      locallyConfirmedServerQueued: input.confirmedServerQueued,
      serverQueue: input.serverQueue ? { ...input.serverQueue } : null,
      serverQueueObserved: input.serverQueueObserved, mode: input.aiMode,
      quota: input.quota ? { ...input.quota } : null,
      result: e ? {
        status: e.status, model: e.model, confidence: e.confidence,
        hasSummary: Boolean(e.summary?.trim()), suggestedTagCount: e.suggested_tags.length,
        hasFolderSuggestion: Boolean(e.suggested_collection_id || e.suggested_collection_name),
        degradedReason: e.degraded_reason, updatedAt: e.updated_at,
      } : null,
    },
  };
}
