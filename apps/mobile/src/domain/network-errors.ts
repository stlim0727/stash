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
 * Number of independently-timed failed attempts needed, all attributed to
 * the same DNS-resolution failure, before the UI treats it as a persistent
 * device/network problem (STASH-4Z: one user hit this on every single create
 * for 24 days straight, always the same `UnknownHostException` for our own
 * host) rather than an ordinary one-off transient blip.
 */
export const REPEATED_DNS_FAILURE_THRESHOLD = 2;

/**
 * True once enough INDEPENDENT attempts have hit the same DNS-resolution
 * failure that it looks like the device/network itself can't reach us, not
 * just a momentary connectivity gap. Drives the more specific "check your
 * connection" status copy instead of the generic connection-wait one.
 *
 * Counts distinct `last_attempt_at` timestamps rather than raw entry rows: a
 * single failed bulk-create request stamps the SAME `last_error_kind` (and
 * the attempted chunk's SAME `last_attempt_at`) onto every entry in that
 * chunk, plus every later untried entry in the same import — one real
 * network failure, not several. Entries with no `last_attempt_at` (never
 * independently attempted) don't count on their own.
 */
export function hasRepeatedDnsFailures(queue: readonly LocalPendingBookmark[]): boolean {
  const attemptTimestamps = new Set(
    queue
      .filter((entry) => entry.sync_status === 'failed' && entry.last_error_kind === 'transient_dns')
      .map((entry) => entry.last_attempt_at)
      .filter((timestamp): timestamp is string => Boolean(timestamp)),
  );
  return attemptTimestamps.size >= REPEATED_DNS_FAILURE_THRESHOLD;
}
import type { LocalPendingBookmark } from '@/domain/types';
