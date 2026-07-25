/**
 * Inbox layout density. The same bookmarks render as rich cards (full-width
 * preview image, inline meta), a compact row (small leading thumbnail + a single
 * meta line), a dense single-line list, or — `folder` — a grid of tappable
 * Collection tiles instead of a flat bookmark list. All of these are purely a
 * presentation choice, so every mode composes with search, facet filtering, and
 * sort exactly the same way; `folder` adds no persisted state beyond the same
 * `INBOX_VIEW_PREF_KEY`. `compact` sits between the other two item layouts: it
 * keeps the card's thumbnail but at list-like density. The tag cloud is no
 * longer a layout: it's a separate, transient "Browse by tag" toggle that is
 * never persisted, so it isn't part of this union.
 */
export type ViewMode = 'card' | 'list' | 'folder';

/** Cards are the historical default — richer, more visual. */
export const DEFAULT_VIEW_MODE: ViewMode = 'card';

/**
 * The layouts in the order the segmented control presents them — richest to
 * densest, with `folder` (a directory of Collections rather than items) last.
 * Also the order `nextViewMode` cycles through.
 */
export const VIEW_MODES: ViewMode[] = ['card', 'list', 'folder'];

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
    case 'folder':
      return 'Folders';
  }
}

export function serializeViewMode(mode: ViewMode): string {
  return mode;
}

export function parseViewMode(raw: string | null | undefined): ViewMode {
  if (raw === 'card') return 'card';
  if (raw === 'list' || raw === 'compact') return 'list';
  if (raw === 'folder') return 'folder';
  return DEFAULT_VIEW_MODE;
}
