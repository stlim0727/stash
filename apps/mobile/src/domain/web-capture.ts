import { extractFirstUrl } from './urls.ts';

/**
 * Web capture entry point: parses the `/add` route's query params (used by the
 * desktop bookmarklet, the PWA Web Share Target, and plain deep links) into a
 * capture intent, and builds the bookmarklet that feeds it. Pure and platform
 * free so it can be exercised under the Node test lane.
 */

/** A query param from expo-router can arrive as a string, an array, or be absent. */
export type RouteParam = string | string[] | undefined;

/** First non-empty value of a route param, trimmed; missing/blank → undefined. */
export function firstParam(value: RouteParam): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface CaptureIntent {
  /** A normalized, saveable URL extracted from the params, or null. */
  url: string | null;
  /** Optional page title carried alongside the URL. */
  title?: string;
  /** Raw shared text, saved as a note when there is no URL. */
  text?: string;
}

/**
 * Parse the `/add` query params into a capture intent, or null when none are
 * present (the screen then shows its manual form).
 *
 * Both `url` and `text` are run through `extractFirstUrl`, so `intent.url` is
 * always a normalized, saveable URL or null — a `url` param carrying interior
 * whitespace or a non-http scheme falls back to the text-note path instead of
 * being lost (mirrors the native share handler). Capture is sacred.
 */
export function parseCaptureParams(params: {
  url?: RouteParam;
  title?: RouteParam;
  text?: RouteParam;
  note?: RouteParam;
}): CaptureIntent | null {
  const rawUrl = firstParam(params.url);
  const rawText = firstParam(params.text) ?? firstParam(params.note);
  if (!rawUrl && !rawText) {
    return null;
  }
  return {
    url: extractFirstUrl(rawUrl) ?? extractFirstUrl(rawText),
    title: firstParam(params.title),
    text: rawText,
  };
}

/**
 * Build the "Save to Stash" bookmarklet for a deployed web `origin`. Dragged to
 * the bookmarks bar, it opens a small popup at the `/add` capture endpoint with
 * the current page's URL + title — so a desktop browser can stash any page in
 * one click without leaving the user's current tab. A trailing slash on the
 * origin is tolerated.
 */
export function buildBookmarklet(origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return (
    'javascript:(function(){' +
    `window.open('${base}/add?url='+encodeURIComponent(window.location.href)+` +
    "'&title='+encodeURIComponent(document.title)," +
    "'stash','width=420,height=600');}())"
  );
}
