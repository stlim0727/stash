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

/** Queue-safe counterpart to `isTransientNetworkError`: uses provenance
 * captured while the original runtime error type was available, never the
 * persisted message text (which may have come from an HTTP response body). */
export function isTransientSyncFailure(entry: LocalPendingBookmark): boolean {
  return entry.sync_status === 'failed' && entry.last_error_kind === 'transient_network';
}
import type { LocalPendingBookmark } from '@/domain/types';
