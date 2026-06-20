/**
 * Inbox layout density. The same bookmarks render either as rich cards (preview
 * image, inline meta), a compact single-line list, or a tag cloud (tags sized
 * by how many bookmarks carry them) — purely a presentation choice, so it
 * composes with search, facet filtering, and sort.
 */
export type ViewMode = 'card' | 'list' | 'cloud';

/** Cards are the historical default — richer, more visual. */
export const DEFAULT_VIEW_MODE: ViewMode = 'card';

/**
 * The layouts in the order the segmented control presents them. Also the order
 * `nextViewMode` cycles through.
 */
export const VIEW_MODES: ViewMode[] = ['card', 'list', 'cloud'];

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
    case 'cloud':
      return 'Tag cloud';
  }
}

export function serializeViewMode(mode: ViewMode): string {
  return mode;
}

export function parseViewMode(raw: string | null | undefined): ViewMode {
  return raw === 'card' || raw === 'list' || raw === 'cloud' ? raw : DEFAULT_VIEW_MODE;
}
