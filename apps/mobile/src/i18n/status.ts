/**
 * Localized labels for the bookmark sync/metadata status chips shown on the
 * Inbox cards and the Detail byline. Kept here so both screens format the same
 * enum values identically. An unknown value falls back to its raw token so a
 * new status never renders blank.
 */
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';
import type { EnrichmentDegradedReason } from '@/domain/types';
import { isTransientNetworkError } from '@/domain/network-errors';

const SYNC_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'status.pending',
  synced: 'status.synced',
  syncing: 'status.syncing',
  failed: 'status.failed',
};

const METADATA_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'status.pending',
  complete: 'status.complete',
  failed: 'status.failed',
  skipped: 'status.skipped',
};

function word(t: TFunction, map: Record<string, MessageKey>, value: string): string {
  const key = map[value];
  return key ? t(key) : value;
}

export function syncStatusLabel(t: TFunction, value: string, lastError?: unknown): string {
  const status =
    value === 'failed' && isTransientNetworkError(lastError)
      ? t('status.waitingForConnection')
      : word(t, SYNC_STATUS_KEYS, value);
  return t('status.syncPrefix', { status });
}

export function metadataStatusLabel(t: TFunction, value: string): string {
  return t('status.metadataPrefix', { status: word(t, METADATA_STATUS_KEYS, value) });
}

/**
 * The subtle status chip shown when an on-device check has confirmed a saved
 * YouTube video is deleted/private (STASH-61). See `Bookmark.video_unavailable`.
 */
export function videoUnavailableLabel(t: TFunction): string {
  return t('status.videoUnavailable');
}

/**
 * The non-error note shown when an AI enrichment came from the basic heuristics
 * instead of the model (M12). A transient rate-limit reads differently from a
 * general outage or a missing model key, so the cause is never hidden. Unknown
 * reasons fall back to the generic "basic suggestions" copy.
 */
const DEGRADED_REASON_KEYS: Record<EnrichmentDegradedReason, MessageKey> = {
  rate_limited: 'detail.aiDegradedRateLimited',
  timeout: 'detail.aiDegradedUnavailable',
  provider_error: 'detail.aiDegradedUnavailable',
  not_configured: 'detail.aiDegradedBasic',
};

export function enrichmentDegradedLabel(
  t: TFunction,
  reason: EnrichmentDegradedReason | null,
): string {
  return t((reason && DEGRADED_REASON_KEYS[reason]) || 'detail.aiDegradedBasic');
}
