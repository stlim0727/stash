/**
 * Localized labels for the bookmark sync/metadata status chips shown on the
 * Inbox cards and the Detail byline. Kept here so both screens format the same
 * enum values identically. An unknown value falls back to its raw token so a
 * new status never renders blank.
 */
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';

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

export function syncStatusLabel(t: TFunction, value: string): string {
  return t('status.syncPrefix', { status: word(t, SYNC_STATUS_KEYS, value) });
}

export function metadataStatusLabel(t: TFunction, value: string): string {
  return t('status.metadataPrefix', { status: word(t, METADATA_STATUS_KEYS, value) });
}
