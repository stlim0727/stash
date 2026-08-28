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
 * Number of currently-failing queue entries needed, all attributed to the
 * same DNS-resolution failure, before the UI treats it as a persistent
 * device/network problem (STASH-4Z: one user hit this on every single create
 * for 24 days straight, always the same `UnknownHostException` for our own
 * host) rather than an ordinary one-off transient blip.
 */
export const REPEATED_DNS_FAILURE_THRESHOLD = 2;

/** True once enough queue entries are stuck on the same DNS-resolution
 * failure that it looks like the device/network itself can't reach us, not
 * just a momentary connectivity gap. Drives the more specific "check your
 * connection" status copy instead of the generic connection-wait one. */
export function hasRepeatedDnsFailures(queue: readonly LocalPendingBookmark[]): boolean {
  const dnsFailures = queue.filter(
    (entry) => entry.sync_status === 'failed' && entry.last_error_kind === 'transient_dns',
  );
  return dnsFailures.length >= REPEATED_DNS_FAILURE_THRESHOLD;
}
import type { LocalPendingBookmark } from '@/domain/types';
