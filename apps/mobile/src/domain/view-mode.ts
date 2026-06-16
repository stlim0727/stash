/**
 * Inbox layout density. The same bookmarks render either as rich cards (preview
 * image, inline meta) or as a compact single-line list — purely a presentation
 * choice, so it composes with search, facet filtering, and sort.
 */
export type ViewMode = 'card' | 'list';

/** Cards are the historical default — richer, more visual. */
export const DEFAULT_VIEW_MODE: ViewMode = 'card';

/** Persistence key for the user's chosen layout (repository meta store). */
export const INBOX_VIEW_PREF_KEY = 'pref.inbox.view';

/** The mode shown after toggling away from the current one. */
export function nextViewMode(mode: ViewMode): ViewMode {
  return mode === 'card' ? 'list' : 'card';
}

/** Short human label for the active layout (used in the control + a11y). */
export function describeViewMode(mode: ViewMode): string {
  return mode === 'card' ? 'Cards' : 'List';
}

export function serializeViewMode(mode: ViewMode): string {
  return mode;
}

export function parseViewMode(raw: string | null | undefined): ViewMode {
  return raw === 'card' || raw === 'list' ? raw : DEFAULT_VIEW_MODE;
}
