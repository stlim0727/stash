/**
 * Classify an error as a transient network/transport failure — a request that
 * never reached the server (device offline, DNS unresolved, connection reset,
 * timed out) as opposed to a response the server actually returned.
 *
 * Used to decide log severity: a transport failure is an expected, user-driven
 * condition (they went offline), so it should be recorded as a `warn`
 * breadcrumb rather than a `console.error` that forwards to Sentry and reads as
 * an outage. A real HTTP error from the server still logs at `error`.
 *
 * The signatures cover the platforms this app runs on: Android/Hermes
 * (`java.net.UnknownHostException`, `Unable to resolve host`), React Native's
 * fetch (`Network request failed`), and web (`Failed to fetch`).
 */
const TRANSIENT_NETWORK_SIGNATURES = [
  'unable to resolve host',
  'unknownhostexception',
  'network request failed',
  'failed to fetch',
  'fetch failed',
  'network is unreachable',
  'connection reset',
  'connection refused',
  'software caused connection abort',
  'the request timed out',
  'timed out',
  'enotfound',
  'econnrefused',
  'econnreset',
  'etimedout',
];

export function isTransientNetworkError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (!message) {
    return false;
  }
  return TRANSIENT_NETWORK_SIGNATURES.some((signature) => message.includes(signature));
}

/** The DNS-resolution-specific subset of {@link TRANSIENT_NETWORK_SIGNATURES}
 * (STASH-4Z): the device couldn't resolve our own API host at all, as opposed
 * to a request that resolved but then timed out or was refused/reset. */
const DNS_RESOLUTION_SIGNATURES = ['unable to resolve host', 'unknownhostexception', 'enotfound'];

export function isDnsResolutionFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (!message) {
    return false;
  }
  return DNS_RESOLUTION_SIGNATURES.some((signature) => message.includes(signature));
}

/** Queue-safe counterpart to `isTransientNetworkError`: uses provenance
 * captured while the original runtime error type was available, never the
 * persisted message text (which may have come from an HTTP response body). */
export function isTransientSyncFailure(entry: LocalPendingBookmark): boolean {
  return (
    entry.sync_status === 'failed' &&
    (entry.last_error_kind === 'transient_network' || entry.last_error_kind === 'transient_dns')
  );
}

/**
 * True once a DNS-resolution failure has proven durable enough to have
 * already earned its own Sentry health escalation (STASH-4Z) — i.e. some
 * currently-failing entry's `retry_count` already crossed
 * `TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD` and
 * `applySyncQueueHealthEscalation` (sync/sync-bookmarks.ts) durably marked
 * `health_escalated_at`.
 *
 * Deliberately reuses that existing marker instead of trying to infer
 * "repeated" from the queue's own current snapshot: a queue entry only ever
 * stores its LATEST attempt (no history), and a bulk-create retry re-stamps
 * the same shared timestamp across a whole chunk each pass — so neither raw
 * entry counts nor attempt timestamps can tell "one real failure that
 * happened to touch N rows" apart from "N independently-timed failures", or
 * "a single entry that's been stuck for a long time" apart from "an entry
 * that only just failed once". `health_escalated_at` already encodes that
 * distinction, durably, at the exact point the retry logic itself decided
 * this had gone on long enough to be a real problem — for a single
 * long-stuck entry just as much as a repeated one.
 *
 * Drives the more specific "check your connection" status copy instead of
 * the generic connection-wait one.
 */
export function hasRepeatedDnsFailures(queue: readonly LocalPendingBookmark[]): boolean {
  return queue.some(
    (entry) =>
      entry.sync_status === 'failed' &&
      entry.last_error_kind === 'transient_dns' &&
      Boolean(entry.health_escalated_at),
  );
}
import type { LocalPendingBookmark } from '@/domain/types';
