/**
 * Inbox layout density. The same bookmarks render as rich cards (full-width
 * preview image, inline meta), a compact row (small leading thumbnail + a single
 * meta line), or a dense single-line list — purely a presentation choice, so it
 * composes with search, facet filtering, and sort. `compact` sits between the
 * other two: it keeps the card's thumbnail but at list-like density. The tag
 * cloud is no longer a layout: it's a separate, transient "Browse by tag" toggle
 * that is never persisted, so it isn't part of this union.
 */
export type ViewMode = 'card' | 'list';

/** Cards are the historical default — richer, more visual. */
export const DEFAULT_VIEW_MODE: ViewMode = 'card';

/**
 * The layouts in the order the segmented control presents them — richest to
 * densest. Also the order `nextViewMode` cycles through.
 */
export const VIEW_MODES: ViewMode[] = ['card', 'list'];

/** Persistence key for the user's chosen layout (repository meta store). */
export const INBOX_VIEW_PREF_KEY = 'pref.inbox.view';

/** The mode shown after advancing one step from the current one (wraps around). */
export function nextViewMode(mode: ViewMode): ViewMode {
  const index = VIEW_MODES.indexOf(mode);
  return VIEW_MODES[(index + 1) % VIEW_MODES.length];
}

/** Short human label for a layout (used in the control + a11y). */
export function describeViewMode(mode: ViewMode): string {
  switch (mode) {
    case 'card':
      return 'Cards';
    case 'list':
      return 'List';
  }
}

export function serializeViewMode(mode: ViewMode): string {
  return mode;
}

export function parseViewMode(raw: string | null | undefined): ViewMode {
  if (raw === 'card') return 'card';
  if (raw === 'list' || raw === 'compact') return 'list';
  return DEFAULT_VIEW_MODE;
}
