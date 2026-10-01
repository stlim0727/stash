import type { LocalPendingBookmark, SyncErrorKind } from './types';

export type LibrarySyncPhase = 'idle' | 'working' | 'retrying' | 'attention' | 'sign_in' | 'permission' | 'offline' | 'paused';
export interface LibrarySyncFlow {
  phase: LibrarySyncPhase;
  remaining: number;
}
export interface SyncFailureObservation { kind: SyncErrorKind; attempts?: number; }

/** Independent durable cloud channels; metadata and AI generation are not uploads. */
export function buildLibrarySyncFlow(input: {
  authStatus: string;
  paused: boolean;
  offline: boolean;
  syncing: boolean;
  queue: readonly LocalPendingBookmark[];
  permanentlyUnsyncableIds?: ReadonlySet<string>;
  tagOps?: readonly { confirmed?: boolean; retry_count?: number; last_error_kind?: SyncErrorKind }[];
  importCollections?: readonly { status: 'pending' | 'failed'; last_error_kind?: SyncErrorKind; retry_count?: number }[];
  enrichmentRestores?: readonly { status: 'pending' | 'failed'; last_error_kind?: SyncErrorKind; retry_count?: number }[];
  runFailure?: SyncFailureObservation | null;
}): LibrarySyncFlow {
  const queue = input.queue.filter((entry) => entry.sync_status !== 'synced' && !input.permanentlyUnsyncableIds?.has(entry.local_id));
  // Confirmed tag removals are still waiting for pull confirmation.
  const tags = input.tagOps ?? [];
  const imports = input.importCollections ?? [];
  const restores = input.enrichmentRestores ?? [];
  const remaining = queue.length + tags.length + imports.length + restores.length;
  const kinds = [input.runFailure?.kind,
    ...queue.filter((entry) => entry.sync_status === 'failed').map((entry) => entry.last_error_kind),
    ...tags.filter((op) => !op.confirmed).map((op) => op.last_error_kind),
    ...imports.filter((item) => item.status === 'failed').map((item) => item.last_error_kind),
    ...restores.filter((item) => item.status === 'failed').map((item) => item.last_error_kind)];
  const phase: LibrarySyncPhase = input.authStatus === 'session_expired' || kinds.includes('auth') ? 'sign_in'
    : input.paused ? 'paused'
    : input.offline ? 'offline'
    : kinds.includes('permission') ? 'permission'
    : input.authStatus === 'error' && remaining > 0 ? 'sign_in'
    : input.syncing ? 'working'
    : input.runFailure?.kind === 'other' && (input.runFailure.attempts ?? 0) >= 3 ? 'attention'
    : queue.some((entry) => entry.sync_status === 'failed' && entry.last_error_kind !== 'transient_dns' && entry.last_error_kind !== 'transient_network' && entry.last_error_kind !== 'retryable_http' && entry.retry_count >= 3) ? 'attention'
    : tags.some((op) => !op.confirmed && op.last_error_kind !== 'transient_dns' && op.last_error_kind !== 'transient_network' && op.last_error_kind !== 'retryable_http' && (op.retry_count ?? 0) >= 3) ? 'attention'
    : [...imports, ...restores].some((item) => item.status === 'failed' && item.last_error_kind !== 'transient_dns' && item.last_error_kind !== 'transient_network' && item.last_error_kind !== 'retryable_http' && (item.retry_count ?? 0) >= 3) ? 'attention'
    : input.runFailure || queue.some((entry) => entry.sync_status === 'failed') || tags.some((op) => !op.confirmed && (op.retry_count ?? 0) > 0)
      || imports.some((item) => item.status === 'failed') || restores.some((item) => item.status === 'failed') ? 'retrying'
    : remaining > 0 ? 'working' : 'idle';
  return { phase, remaining };
}

export const SYNC_SHOW_DELAY_MS = 1_500;
export const SYNC_DELAYED_AFTER_MS = 15_000;
export const SYNC_COMPLETE_HOLD_MS = 2_500;
export type SyncDisplayPhase = 'hidden' | 'syncing' | 'delayed' | 'complete' | Exclude<LibrarySyncPhase, 'idle' | 'working' | 'retrying'>;
export interface SyncDisplayState {
  phase: SyncDisplayPhase;
  busySince: number | null;
  completeUntil: number | null;
}
export const INITIAL_SYNC_DISPLAY: SyncDisplayState = { phase: 'hidden', busySince: null, completeUntil: null };

/** No completion with outstanding work; blockers always override display timers. */
export function advanceSyncDisplay(previous: SyncDisplayState, flow: LibrarySyncFlow, now: number): SyncDisplayState {
  if (flow.phase !== 'working' && flow.phase !== 'retrying' && flow.phase !== 'idle') {
    return { phase: flow.phase, busySince: null, completeUntil: null };
  }
  if (flow.phase !== 'idle' || flow.remaining > 0) {
    const busySince = previous.busySince ?? now;
    const displayed = previous.phase === 'syncing' || previous.phase === 'delayed' || previous.phase === 'complete';
    const phase = flow.phase === 'retrying'
      ? now - busySince >= SYNC_DELAYED_AFTER_MS ? 'delayed' : displayed ? 'syncing' : 'hidden'
      : displayed || now - busySince >= SYNC_SHOW_DELAY_MS ? 'syncing' : 'hidden';
    return { phase, busySince, completeUntil: null };
  }
  if (previous.phase === 'syncing' || previous.phase === 'delayed') {
    return { phase: 'complete', busySince: null, completeUntil: now + SYNC_COMPLETE_HOLD_MS };
  }
  if (previous.phase === 'complete' && previous.completeUntil !== null && now < previous.completeUntil) return previous;
  return INITIAL_SYNC_DISPLAY;
}

export function nextSyncDisplayAt(state: SyncDisplayState, flow: LibrarySyncFlow): number | null {
  if (state.phase === 'complete') return state.completeUntil;
  if (state.busySince === null) return null;
  if (state.phase === 'hidden') return state.busySince + (flow.phase === 'retrying' ? SYNC_DELAYED_AFTER_MS : SYNC_SHOW_DELAY_MS);
  if (flow.phase === 'retrying' && state.phase !== 'delayed') return state.busySince + SYNC_DELAYED_AFTER_MS;
  return null;
}
