import type { Bookmark } from '@/domain/types';

/**
 * Every Inbox item gets a leading icon. Prefer the enriched favicon; when none
 * is available yet (offline saves, pending enrichment, bare text) fall back to
 * a deterministic letter monogram so the list never has blank icon slots.
 *
 * Pure and dependency-free so the choice is unit-testable; the screen just
 * renders whichever variant this returns.
 */

export interface FaviconIcon {
  kind: 'favicon';
  uri: string;
}

export interface MonogramIcon {
  kind: 'monogram';
  letter: string;
  /** Index into MONOGRAM_COLORS — stable per site so the color doesn't flicker. */
  colorIndex: number;
}

export type ItemIcon = FaviconIcon | MonogramIcon;

/** Distinct, legible backgrounds for fallback monograms. */
export const MONOGRAM_COLORS = [
  '#208aef',
  '#e0457b',
  '#2bb673',
  '#f59e0b',
  '#8b5cf6',
  '#0ea5e9',
  '#ef4444',
  '#14b8a6',
];

/** Host without a leading `www.`, or null when the URL is missing/unparsable. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function firstLetter(source: string): string {
  for (const ch of source) {
    if (/[a-z0-9]/i.test(ch)) {
      return ch.toUpperCase();
    }
  }
  return '#';
}

/** Deterministic 0..n-1 color slot from a seed so a site keeps its color. */
export function monogramColorIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % MONOGRAM_COLORS.length;
}

/**
 * The colored letter fallback for a bookmark — used when there's no favicon, or
 * when a favicon URL is present but fails to load on-device.
 */
export function monogramIcon(bookmark: Bookmark): MonogramIcon {
  const host = hostFromUrl(bookmark.url);
  // Letter prefers the human site name, then the domain, then the title.
  const label = bookmark.site_name?.trim() || host || bookmark.title?.trim() || '#';
  // Color seed prefers the stable domain so the same site is always one color.
  const seed = host ?? label;
  return { kind: 'monogram', letter: firstLetter(label), colorIndex: monogramColorIndex(seed) };
}

export function itemIcon(bookmark: Bookmark): ItemIcon {
  const favicon = bookmark.favicon_url?.trim();
  if (favicon) {
    return { kind: 'favicon', uri: favicon };
  }
  return monogramIcon(bookmark);
}
