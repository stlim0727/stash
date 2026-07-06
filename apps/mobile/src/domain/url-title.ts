/**
 * Pure, network-free derivation of a *human* title from a URL alone.
 *
 * This is the floor under every preview: whatever a card shows one millisecond
 * after capture, with zero network, before (or instead of) a real page fetch.
 * A good floor is what stops a bookmark ever looking broken — so the rules here
 * bias toward a readable label over a raw host or an opaque id.
 *
 * Two failure shapes motivated it:
 *  - a `youtu.be/<id>` link fell back to the bare host `youtu.be` (redundant
 *    with the URL shown right below it), and
 *  - a `threads.com/@user/post/<id>` link fell back to the post id slug
 *    (`Dabls52E90n`), which reads like a random string.
 * For exactly the platforms that resist scraping (login-walled JS shells) the
 * URL *path* is the richest human signal we have, and it needs no fetch.
 */

// Relative .ts import (not the @ alias) so Node's test runner can resolve it.
import { youtubeVideoId } from './page-metadata.ts';

export interface UrlTitle {
  title: string;
  /** A thumbnail derivable from the URL alone (currently YouTube only). */
  preview_image_url: string | null;
}

function handleFrom(segment: string | undefined): string | null {
  if (!segment) {
    return null;
  }
  const handle = segment.startsWith('@') ? segment.slice(1) : segment;
  return handle || null;
}

/**
 * A human title for URLs on known platforms whose page resists scraping or
 * whose identifying path segment is opaque. Network-free; returns null for
 * hosts we have no special knowledge of (the caller then derives from the slug
 * or falls back to the host).
 *
 * For social posts we lead with the *author* (`@handle`) when the path carries
 * one — weeks later, "who" is a better recognition cue than a truncated body.
 */
export function describeKnownUrl(rawUrl: string): UrlTitle | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const segs = url.pathname.split('/').filter(Boolean);

  // YouTube: the id is opaque, but it deterministically yields both a clean
  // label and a real thumbnail — so a failed fetch still looks fully enriched.
  const videoId = youtubeVideoId(rawUrl);
  if (videoId) {
    return {
      title: 'YouTube video',
      preview_image_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  }

  // Each social handler matches only the *post* URL shape it recognizes and
  // returns null otherwise, so a profile/landing URL (e.g. `instagram.com/natgeo`)
  // falls through to generic slug derivation instead of being mislabeled as a
  // post — which matters doubly because these hosts are structurally
  // unfetchable, so a wrong label would stick.
  if (host === 'threads.com' || host === 'threads.net') {
    if (segs[1] !== 'post') {
      return null;
    }
    const handle = handleFrom(segs[0]);
    return { title: handle ? `Threads post by @${handle}` : 'Threads post', preview_image_url: null };
  }

  if (host === 'instagram.com') {
    const kind = segs[0];
    if (kind === 'reel' || kind === 'reels') {
      return { title: 'Instagram reel', preview_image_url: null };
    }
    if (kind === 'tv') {
      return { title: 'Instagram video', preview_image_url: null };
    }
    if (kind === 'p') {
      return { title: 'Instagram post', preview_image_url: null };
    }
    return null; // a profile URL, not a post
  }

  if (host === 'x.com' || host === 'twitter.com') {
    if (segs[1] !== 'status') {
      return null;
    }
    const user = handleFrom(segs[0]);
    return { title: user ? `Post by @${user} on X` : 'Post on X', preview_image_url: null };
  }

  if (host === 'tiktok.com') {
    if (segs[1] !== 'video') {
      return null;
    }
    const user = segs[0]?.startsWith('@') ? handleFrom(segs[0]) : null;
    return { title: user ? `TikTok by @${user}` : 'TikTok video', preview_image_url: null };
  }

  if (host === 'reddit.com' || host === 'old.reddit.com') {
    if (segs[0] !== 'r' || segs[2] !== 'comments') {
      return null; // a subreddit or listing page, not a post
    }
    // Reddit is the exception among these platforms: a comment URL usually
    // carries a readable title slug (segs[4], e.g. `how_to_make_pancakes`), which
    // Title-Cases into a far better label than the generic subreddit name. Defer
    // to generic slug derivation when it's present; only fall back to the
    // subreddit label for a slugless post URL.
    if (segs[4] && !looksOpaqueId(segs[4])) {
      return null;
    }
    return { title: `Reddit post in r/${segs[1]}`, preview_image_url: null };
  }

  if (host === 'github.com') {
    const [owner, repo] = segs;
    if (owner && repo) {
      return { title: `${owner}/${repo} on GitHub`, preview_image_url: null };
    }
    return null; // a bare profile has no better label than the host
  }

  return null;
}

/**
 * Does a path segment read like an opaque id (`Dabls52E90n`, `MEvcN4Nwa1g`, a
 * long hash, a numeric id) rather than human words? Such a segment makes a poor
 * title — it looks random — so the caller prefers the host over Title-Casing
 * it. Deliberately conservative: a real word with a separator or a short
 * word+number (`iphone15`, `html5`) is NOT opaque.
 */
export function looksOpaqueId(segment: string): boolean {
  let s: string;
  try {
    s = decodeURIComponent(segment);
  } catch {
    s = segment;
  }
  s = s.replace(/\.[a-z0-9]+$/i, ''); // drop a trailing file extension
  if (!s || /[-_+\s]/.test(s)) {
    return false; // separators → treat as words
  }
  const internalMixedCase = /[a-z]/.test(s) && /[A-Z]/.test(s);
  if (internalMixedCase && /\d/.test(s)) {
    return true; // Dabls52E90n, MEvcN4Nwa1g
  }
  if (/^\d{6,}$/.test(s)) {
    return true; // long numeric id
  }
  if (/^[0-9a-f]{16,}$/i.test(s)) {
    return true; // hex hash
  }
  // No bare length rule: a long single-token slug is usually a real word
  // ("internationalization") or a percent-decoded CJK title, not an id. Only
  // the shape-based patterns above (mixed-case-with-digit, long numeric, hex)
  // count as opaque, so a readable slug is kept.
  return false;
}
