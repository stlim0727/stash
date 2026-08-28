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
 * Retry count at which an expected transport failure (offline/DNS) is
 * treated as a genuinely prolonged outage rather than a momentary blip
 * (STASH-4Z) — see `applySyncQueueHealthEscalation` in
 * sync/sync-bookmarks.ts, the Sentry health-escalation gate this same
 * number drives. Lives here (not in sync/) so this pure UI signal below can
 * use the identical threshold without sync/ importing back into domain/.
 */
export const TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD = 6;

/**
 * True once a currently-failing entry's OWN `retry_count` has crossed
 * {@link TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD} while its most
 * recent failure is specifically a DNS-resolution one — i.e. this looks
 * like a genuinely persistent device/network problem, not a momentary blip.
 *
 * Checks `retry_count` directly rather than the entry's `health_escalated_at`
 * marker: that marker is cross-kind and sticky by design (set once, kept
 * even if a later retry's failure kind changes — see
 * `applySyncQueueHealthEscalation`'s comment on preventing duplicate
 * alerts), so an entry that escalated an ORDINARY failure at retry 3 and
 * only later happened to fail once on DNS would already read as escalated
 * despite never having actually retried 6 times against DNS. `retry_count`
 * is the durable, per-entry, kind-agnostic attempt count that doesn't have
 * that gap — including through a bulk-create retry, where each entry's own
 * `retry_count` only advances on an attempt IT was actually part of (unlike
 * `last_attempt_at`, which a shared batch re-stamps across a whole chunk
 * regardless of each entry's real attempt history).
 *
 * Drives the more specific "check your connection" status copy instead of
 * the generic connection-wait one.
 */
export function hasRepeatedDnsFailures(queue: readonly LocalPendingBookmark[]): boolean {
  return queue.some(
    (entry) =>
      entry.sync_status === 'failed' &&
      entry.last_error_kind === 'transient_dns' &&
      entry.retry_count >= TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD,
  );
}
import type { LocalPendingBookmark } from '@/domain/types';
