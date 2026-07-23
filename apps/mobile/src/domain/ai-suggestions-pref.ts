/**
 * The user's global AI-suggestions mode (STASH #573): how much the app is
 * allowed to do on its own with AI tag/folder suggestions.
 *
 *  - `off` — never auto-trigger AI enrichment for a bookmark. A manual
 *    "Suggest with AI" tap on Detail still works in every mode; this only
 *    gates the automatic background trigger.
 *  - `confirm` — today's existing behavior: auto-trigger runs, but
 *    suggestions sit in the review badge/card for the user to accept or
 *    dismiss. The default.
 *  - `auto_accept` — auto-trigger runs AND high-confidence suggestions are
 *    applied automatically (see `domain/ai-suggestions.ts`'s
 *    `SUGGESTION_MIN_CONFIDENCE`), with no review step.
 *
 * Follows the same shape as `domain/view-mode.ts`: a type union, a default, a
 * persistence key, and parse/serialize helpers, persisted through the
 * repository meta store (`storage/preferences.ts` on the UI side,
 * `repository.getMeta`/`setMeta` directly from the store, since this
 * preference also gates store-internal logic).
 */
export type AiSuggestionsMode = 'off' | 'confirm' | 'auto_accept';

/** "Confirm" (today's existing review-badge behavior) is the default — this
 *  feature must not change behavior for anyone who never opens the setting. */
export const DEFAULT_AI_SUGGESTIONS_MODE: AiSuggestionsMode = 'confirm';

/** Persistence key for the user's chosen mode (repository meta store). */
export const AI_SUGGESTIONS_MODE_PREF_KEY = 'pref.ai.suggestions_mode';

/** The modes in the order the settings sheet presents them. */
export const AI_SUGGESTIONS_MODES: AiSuggestionsMode[] = ['off', 'confirm', 'auto_accept'];

export function serializeAiSuggestionsMode(mode: AiSuggestionsMode): string {
  return mode;
}

export function parseAiSuggestionsMode(raw: string | null | undefined): AiSuggestionsMode {
  if (raw === 'off') return 'off';
  if (raw === 'confirm') return 'confirm';
  if (raw === 'auto_accept') return 'auto_accept';
  return DEFAULT_AI_SUGGESTIONS_MODE;
}
