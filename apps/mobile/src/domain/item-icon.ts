import { markdownLabel } from '@/domain/markdown';
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

export interface PreviewWordmark {
  label: string;
  /** Stable visual variant so repeated cards from one site feel related. */
  variant: number;
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
    if (/[\p{L}\p{N}]/u.test(ch)) {
      return ch.toUpperCase();
    }
  }
  return '#';
}

const COMMON_SECOND_LEVEL_SUFFIXES = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

function hostKeyword(host: string): string {
  const parts = host.split('.');
  const last = parts.at(-1) ?? '';
  const secondLast = parts.at(-2) ?? '';
  const suffixLength =
    last.length === 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(secondLast) ? 2 : 1;
  return parts.at(-(suffixLength + 1)) ?? parts.at(-2) ?? parts[0] ?? host;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [0, 0, 0];
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Pick whichever of the app's light/dark foregrounds has stronger WCAG contrast. */
export function wordmarkForeground(background: string): '#172033' | '#ffffff' {
  const backgroundLuminance = relativeLuminance(background);
  const darkLuminance = relativeLuminance('#172033');
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  const darkContrast =
    (Math.max(backgroundLuminance, darkLuminance) + 0.05) /
    (Math.min(backgroundLuminance, darkLuminance) + 0.05);
  return darkContrast > whiteContrast ? '#172033' : '#ffffff';
}

/**
 * Short display copy for a full-card fallback. It deliberately stays local and
 * deterministic: this is a typographic placeholder, not fabricated site art.
 */
export function previewWordmark(bookmark: Bookmark): PreviewWordmark {
  const host = hostFromUrl(bookmark.url);
  const siteName = bookmark.site_name?.trim();
  const humanSiteName = siteName?.replace(/^www\./, '') === host ? null : siteName;
  const source =
    humanSiteName ||
    (host ? hostKeyword(host) : null) ||
    bookmark.title?.trim() ||
    markdownLabel(bookmark.description ?? '') ||
    '#';
  const label = Array.from(source.replace(/\s+/g, ' ').trim())
    .slice(0, 28)
    .join('')
    .toLocaleUpperCase();
  return { label, variant: monogramColorIndex(host ?? source) };
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
  const label =
    bookmark.site_name?.trim() ||
    host ||
    bookmark.title?.trim() ||
    markdownLabel(bookmark.description ?? '') ||
    '#';
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
