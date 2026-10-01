import type { LocalPendingBookmark, SyncErrorKind } from '@/domain/types';
import { isPermanentlyUnsyncableUrl, uploadRetryBackoffMs, UPLOAD_RETRY_BACKOFF_MS } from '@/sync/sync-bookmarks';

export interface SyncRunFailure { kind: SyncErrorKind; at: number; attempts: number; }
export interface RetryableFollowup {
  status: 'pending' | 'failed'; last_error_kind?: SyncErrorKind;
  retry_count?: number; last_attempt_at?: string;
}
export function canAutomaticallyRetry(kind: SyncErrorKind | null | undefined, attempts: number): boolean {
  return kind !== 'auth' && kind !== 'permission' &&
    (kind === 'transient_dns' || kind === 'transient_network' || kind === 'retryable_http' || attempts < 3);
}

export function syncRunRetryReadyAt(failure: SyncRunFailure): number {
  const base = UPLOAD_RETRY_BACKOFF_MS[Math.min(Math.max(0, failure.attempts - 1), UPLOAD_RETRY_BACKOFF_MS.length - 1)]!;
  return failure.at + base * (failure.kind === 'transient_dns' || failure.kind === 'transient_network' ? 3 : 1);
}

export function isPullReady(failure: SyncRunFailure | null, now: number, force = false): boolean {
  return force || !failure || (canAutomaticallyRetry(failure.kind, failure.attempts) && now >= syncRunRetryReadyAt(failure));
}

/** A stable hydration anchor gives legacy failures without timestamps one quiet wait. */
export function followupRetryReadyAt(item: RetryableFollowup, legacyAttemptAt: number): number {
  const at = Date.parse(item.last_attempt_at ?? '');
  if (!Number.isFinite(at)) return legacyAttemptAt + 30_000;
  const base = UPLOAD_RETRY_BACKOFF_MS[Math.min(Math.max(0, (item.retry_count ?? 1) - 1), UPLOAD_RETRY_BACKOFF_MS.length - 1)]!;
  return at + base * (item.last_error_kind === 'transient_dns' || item.last_error_kind === 'transient_network' ? 3 : 1);
}

export function isFollowupReady(item: RetryableFollowup, now: number, legacyAttemptAt: number, force = false): boolean {
  return force || item.status === 'pending' ||
    (canAutomaticallyRetry(item.last_error_kind, item.retry_count ?? 0) && now >= followupRetryReadyAt(item, legacyAttemptAt));
}

/** Use upload backoff, including the network multiplier; never force retries. */
export function nextAutomaticSyncRetryAt(input: {
  queue: readonly LocalPendingBookmark[];
  runFailure: SyncRunFailure | null;
  followups?: readonly RetryableFollowup[];
  now: number;
  legacyFollowupAttemptAt?: number;
}): number | null {
  if (input.runFailure?.kind === 'auth' || input.runFailure?.kind === 'permission') return null;
  const deadlines: number[] = [];
  for (const entry of input.queue) {
    if (entry.sync_status !== 'failed' || isPermanentlyUnsyncableUrl(entry) ||
        !canAutomaticallyRetry(entry.last_error_kind, entry.retry_count)) continue;
    const attemptedAt = Date.parse(entry.last_attempt_at ?? '');
    deadlines.push((Number.isFinite(attemptedAt) ? attemptedAt : input.now) + Math.max(5_000, uploadRetryBackoffMs(entry)));
  }
  const failure = input.runFailure;
  if (failure && canAutomaticallyRetry(failure.kind, failure.attempts)) {
    deadlines.push(syncRunRetryReadyAt(failure));
  }
  for (const item of input.followups ?? []) {
    if (item.status !== 'failed' || !canAutomaticallyRetry(item.last_error_kind, item.retry_count ?? 0)) continue;
    deadlines.push(followupRetryReadyAt(item, input.legacyFollowupAttemptAt ?? input.now));
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}
