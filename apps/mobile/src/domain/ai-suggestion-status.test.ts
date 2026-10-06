import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveAiSuggestionStatus } from './ai-suggestion-status.ts';
import type { AIEnrichment } from './types.ts';

function makeEnrichment(overrides: Partial<AIEnrichment> = {}): AIEnrichment {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'enrichment-1',
    user_id: 'user-1',
    bookmark_id: 'bookmark-1',
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    summary: null,
    confidence: 0.9,
    model: 'gemini-2.0',
    degraded: false,
    degraded_reason: null,
    status: 'complete',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test('deriveAiSuggestionStatus: preview failure outranks all states and suppresses retry actions', () => {
  const result = deriveAiSuggestionStatus({
    working: true,
    manual: true,
    postponed: true,
    serverQueued: true,
    previewFailed: true,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'rate_limited' }),
  });

  assert.equal(result.kind, 'preview_unavailable');
  assert.equal(result.actionMode, 'none');
  assert.equal(result.messageKey, 'detail.aiPreviewFailed');
  assert.equal(result.actionLabelKey, null);
});

test('deriveAiSuggestionStatus: manual generation shows generating action and disables banner', () => {
  const result = deriveAiSuggestionStatus({
    working: true,
    manual: true,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
  });

  assert.equal(result.kind, 'generating');
  assert.equal(result.actionMode, 'generating');
  assert.equal(result.messageKey, null);
  assert.equal(result.actionLabelKey, 'detail.aiGenerating');
});

test('deriveAiSuggestionStatus: confirmed server queue entry outranks local postponed note', () => {
  const result = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: true,
    serverQueued: true,
    previewFailed: false,
    hasActionableSuggestions: false,
  });

  assert.equal(result.kind, 'server_queued');
  assert.equal(result.actionMode, 'retry_now');
  assert.equal(result.messageKey, 'detail.aiQueued');
  assert.equal(result.actionLabelKey, 'detail.aiRetryNow');
});

test('deriveAiSuggestionStatus: server queue suppresses button when offline / cannot organize remotely', () => {
  const result = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: true,
    serverQueued: true,
    previewFailed: false,
    hasActionableSuggestions: false,
    canOrganizeRemotely: false,
  });

  assert.equal(result.kind, 'server_queued');
  assert.equal(result.actionMode, 'none');
  assert.equal(result.messageKey, 'detail.aiQueued');
  assert.equal(result.actionLabelKey, null);
});

test('deriveAiSuggestionStatus: armed retry marker takes precedence over older degraded enrichment row', () => {
  const result = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: true,
    serverQueued: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'rate_limited' }),
  });

  assert.equal(result.kind, 'retry_scheduled');
  assert.equal(result.actionMode, 'retry_now');
  assert.equal(result.messageKey, 'detail.aiPostponed');
  assert.equal(result.actionLabelKey, 'detail.aiRetryNow');
});

test('deriveAiSuggestionStatus: armed retry with no prior enrichment row says Retry now instead of Suggest with AI', () => {
  const result = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: true,
    serverQueued: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: null,
  });

  assert.equal(result.kind, 'retry_scheduled');
  assert.equal(result.actionMode, 'retry_now');
  assert.equal(result.messageKey, 'detail.aiPostponed');
  assert.equal(result.actionLabelKey, 'detail.aiRetryNow');
});

test('deriveAiSuggestionStatus: background in-flight generation leaves trigger interactable', () => {
  const fresh = deriveAiSuggestionStatus({
    working: true,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: null,
  });
  assert.equal(fresh.kind, 'generating');
  assert.equal(fresh.actionMode, 'suggest');
  assert.equal(fresh.messageKey, null);
  assert.equal(fresh.actionLabelKey, 'detail.aiSuggest');

  const refresh = deriveAiSuggestionStatus({
    working: true,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment(),
  });
  assert.equal(refresh.kind, 'generating');
  assert.equal(refresh.actionMode, 'refresh');
  assert.equal(refresh.messageKey, null);
  assert.equal(refresh.actionLabelKey, 'detail.aiRefresh');
});

test('deriveAiSuggestionStatus: capacity-limited degraded failure with no retry scheduled', () => {
  const withoutSuggestions = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'rate_limited' }),
  });
  assert.equal(withoutSuggestions.kind, 'capacity_limited');
  assert.equal(withoutSuggestions.actionMode, 'retry');
  assert.equal(withoutSuggestions.messageKey, 'detail.aiCapacityLimited');
  assert.equal(withoutSuggestions.actionLabelKey, 'detail.aiRetry');

  const withSuggestions = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'rate_limited' }),
  });
  assert.equal(withSuggestions.kind, 'capacity_limited');
  assert.equal(withSuggestions.actionMode, 'retry');
  assert.equal(withSuggestions.messageKey, 'detail.aiDegradedRateLimited');
  assert.equal(withSuggestions.actionLabelKey, 'detail.aiRetry');
});

test('deriveAiSuggestionStatus: provider error and timeout degraded failures with no retry scheduled', () => {
  const providerErrorNoSuggestions = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'provider_error' }),
  });
  assert.equal(providerErrorNoSuggestions.kind, 'temporarily_unavailable');
  assert.equal(providerErrorNoSuggestions.actionMode, 'retry');
  assert.equal(providerErrorNoSuggestions.messageKey, 'detail.aiProviderError');
  assert.equal(providerErrorNoSuggestions.actionLabelKey, 'detail.aiRetry');

  const timeoutWithSuggestions = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'timeout' }),
  });
  assert.equal(timeoutWithSuggestions.kind, 'temporarily_unavailable');
  assert.equal(timeoutWithSuggestions.actionMode, 'retry');
  assert.equal(timeoutWithSuggestions.messageKey, 'detail.aiDegradedUnavailable');
  assert.equal(timeoutWithSuggestions.actionLabelKey, 'detail.aiRetry');

  const notConfiguredWithSuggestions = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ degraded: true, degraded_reason: 'not_configured' }),
  });
  assert.equal(notConfiguredWithSuggestions.kind, 'temporarily_unavailable');
  assert.equal(notConfiguredWithSuggestions.messageKey, 'detail.aiDegradedBasic');
});

test('deriveAiSuggestionStatus: healthy empty result is distinguishable from a failed attempt', () => {
  const result = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: makeEnrichment({ degraded: false, degraded_reason: null }),
  });

  assert.equal(result.kind, 'empty');
  assert.equal(result.actionMode, 'refresh');
  assert.equal(result.messageKey, 'detail.aiEmpty');
  assert.equal(result.actionLabelKey, 'detail.aiRefreshSuggestions');
});

test('deriveAiSuggestionStatus: ready state with actionable suggestions', () => {
  const fresh = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ status: 'complete' }),
  });
  assert.equal(fresh.kind, 'ready');
  assert.equal(fresh.actionMode, 'refresh');
  assert.equal(fresh.messageKey, null);
  assert.equal(fresh.actionLabelKey, 'detail.aiRefresh');

  const stale = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: true,
    enrichment: makeEnrichment({ status: 'stale' }),
  });
  assert.equal(stale.kind, 'ready');
  assert.equal(stale.actionMode, 'refresh');
  assert.equal(stale.messageKey, 'detail.aiStale');
  assert.equal(stale.actionLabelKey, 'detail.aiRefresh');
});

test('deriveAiSuggestionStatus: initial idle state when no attempt has occurred', () => {
  const canOrganize = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: null,
    canOrganizeRemotely: true,
  });
  assert.equal(canOrganize.kind, 'initial');
  assert.equal(canOrganize.actionMode, 'suggest');
  assert.equal(canOrganize.messageKey, null);
  assert.equal(canOrganize.actionLabelKey, 'detail.aiSuggest');

  const cannotOrganize = deriveAiSuggestionStatus({
    working: false,
    manual: false,
    postponed: false,
    previewFailed: false,
    hasActionableSuggestions: false,
    enrichment: null,
    canOrganizeRemotely: false,
  });
  assert.equal(cannotOrganize.kind, 'initial');
  assert.equal(cannotOrganize.actionMode, 'none');
  assert.equal(cannotOrganize.messageKey, 'detail.aiNeedsSync');
  assert.equal(cannotOrganize.actionLabelKey, null);
});
