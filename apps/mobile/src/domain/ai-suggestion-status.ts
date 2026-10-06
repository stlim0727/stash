import type { AIEnrichment } from './types.ts';
import type { MessageKey } from '../i18n/messages.ts';

export type AiSuggestionStatusKind =
  | 'preview_unavailable'
  | 'generating'
  | 'server_queued'
  | 'retry_scheduled'
  | 'capacity_limited'
  | 'temporarily_unavailable'
  | 'empty'
  | 'ready'
  | 'initial';

export type AiSuggestionActionMode =
  | 'none'
  | 'generating'
  | 'retry_now'
  | 'retry'
  | 'refresh'
  | 'suggest';

export interface AiSuggestionStatusInput {
  /** The enrichment row if any exists for this bookmark. */
  enrichment?: AIEnrichment | null;
  /** Whether an AI request is actively working (auto or manual). */
  working: boolean;
  /** Whether a manual AI request was initiated by the user. */
  manual: boolean;
  /** Whether an automatic retry is scheduled / postponed waiting out backoff. */
  postponed: boolean;
  /** Whether confirmed accepted into server-side overflow queue. */
  serverQueued?: boolean;
  /** Whether the bookmark's metadata/preview fetch failed. */
  previewFailed: boolean;
  /** Whether there are actionable suggestions to show (tags, folder, summary). */
  hasActionableSuggestions: boolean;
  /** Whether remote organization / sync is available for AI features. Default true. */
  canOrganizeRemotely?: boolean;
}

export interface AiSuggestionStatusResult {
  kind: AiSuggestionStatusKind;
  actionMode: AiSuggestionActionMode;
  messageKey: MessageKey | null;
  actionLabelKey: MessageKey | null;
}

/**
 * Pure Detail-screen AI suggestion status derivation.
 *
 * Deterministically derives exactly one current AI status and its appropriate
 * user action mode from the bookmark's current signals.
 *
 * Precedence:
 * 1. Preview failure (outranks all AI states; no misleading retry action).
 * 2. Manual in-flight generation (explicit user action; disables action).
 * 3. Server queued (confirmed overflow queue entry; self-resolving promise).
 * 4. Retry scheduled (local armed retry marker waiting out backoff; outranks stale rows).
 * 5. Background in-flight generation (auto-trigger leaves button interactable).
 * 6. Completed enrichment:
 *    a. Degraded rate limit -> capacity_limited (retry action).
 *    b. Degraded provider/timeout -> temporarily_unavailable (retry action).
 *    c. Healthy with suggestions -> ready (refresh action).
 *    d. Healthy with no suggestions -> empty (refresh action).
 * 7. Initial idle state (no enrichment attempt yet; suggest action).
 */
export function deriveAiSuggestionStatus(
  input: AiSuggestionStatusInput,
): AiSuggestionStatusResult {
  const canOrganize = input.canOrganizeRemotely !== false;

  // 1. Preview failure outranks all AI states. If metadata fetch failed,
  // AI cannot run and no misleading AI retry action is shown.
  if (input.previewFailed) {
    return {
      kind: 'preview_unavailable',
      actionMode: 'none',
      messageKey: 'detail.aiPreviewFailed',
      actionLabelKey: null,
    };
  }

  // 2. Explicit manual user request is active.
  if (input.manual) {
    return {
      kind: 'generating',
      actionMode: 'generating',
      messageKey: null,
      actionLabelKey: 'detail.aiGenerating',
    };
  }

  // 3. Confirmed server-side queue entry outranks generic local postponed note.
  if (input.serverQueued) {
    return {
      kind: 'server_queued',
      actionMode: canOrganize ? 'retry_now' : 'none',
      messageKey: 'detail.aiQueued',
      actionLabelKey: canOrganize ? 'detail.aiRetryNow' : null,
    };
  }

  // 4. Live armed automatic retry marker waiting out backoff outranks older completed rows.
  if (input.postponed) {
    return {
      kind: 'retry_scheduled',
      actionMode: canOrganize ? 'retry_now' : 'none',
      messageKey: 'detail.aiPostponed',
      actionLabelKey: canOrganize ? 'detail.aiRetryNow' : null,
    };
  }

  // 5. Automatic background request in flight without a manual trigger.
  if (input.working) {
    return {
      kind: 'generating',
      actionMode: canOrganize ? (input.enrichment ? 'refresh' : 'suggest') : 'none',
      messageKey: null,
      actionLabelKey: canOrganize ? (input.enrichment ? 'detail.aiRefresh' : 'detail.aiSuggest') : null,
    };
  }

  // 6. Completed enrichment row exists.
  if (input.enrichment) {
    if (input.enrichment.degraded) {
      if (input.enrichment.degraded_reason === 'rate_limited') {
        return {
          kind: 'capacity_limited',
          actionMode: canOrganize ? 'retry' : 'none',
          messageKey: input.hasActionableSuggestions
            ? 'detail.aiDegradedRateLimited'
            : 'detail.aiCapacityLimited',
          actionLabelKey: canOrganize ? 'detail.aiRetry' : null,
        };
      }

      // Other degraded reason (timeout, provider_error, not_configured, etc.)
      const messageKey = input.hasActionableSuggestions
        ? input.enrichment.degraded_reason === 'not_configured'
          ? 'detail.aiDegradedBasic'
          : 'detail.aiDegradedUnavailable'
        : 'detail.aiProviderError';

      return {
        kind: 'temporarily_unavailable',
        actionMode: canOrganize ? 'retry' : 'none',
        messageKey,
        actionLabelKey: canOrganize ? 'detail.aiRetry' : null,
      };
    }

    // Healthy, non-degraded AI completion.
    if (input.hasActionableSuggestions) {
      return {
        kind: 'ready',
        actionMode: canOrganize ? 'refresh' : 'none',
        messageKey: input.enrichment.status === 'stale' ? 'detail.aiStale' : null,
        actionLabelKey: canOrganize ? 'detail.aiRefresh' : null,
      };
    }

    // Successful AI response, but nothing useful to suggest.
    return {
      kind: 'empty',
      actionMode: canOrganize ? 'refresh' : 'none',
      messageKey: 'detail.aiEmpty',
      actionLabelKey: canOrganize ? 'detail.aiRefreshSuggestions' : null,
    };
  }

  // 7. Initial idle state (no enrichment attempted yet).
  return {
    kind: 'initial',
    actionMode: canOrganize ? 'suggest' : 'none',
    messageKey: canOrganize ? null : 'detail.aiNeedsSync',
    actionLabelKey: canOrganize ? 'detail.aiSuggest' : null,
  };
}
