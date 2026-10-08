import { isSafeMarkdownLink } from './markdown.ts';

export interface PlainTextSegment {
  type: 'text' | 'link';
  text: string;
  url?: string;
}

const TRAILING_PUNCTUATION = /[.,;:!?"'<>]+$/;

/**
 * Trims trailing punctuation from a matched URL while preserving balanced
 * parentheses, brackets, and braces (e.g. Wikipedia links or URLs wrapped in parens).
 */
export function cleanTrailingUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = '';

  const punctMatch = url.match(TRAILING_PUNCTUATION);
  if (punctMatch) {
    trailing = punctMatch[0] + trailing;
    url = url.slice(0, url.length - punctMatch[0].length);
  }

  while (url.endsWith(')')) {
    const openCount = (url.match(/\(/g) || []).length;
    const closeCount = (url.match(/\)/g) || []).length;
    if (closeCount > openCount) {
      trailing = ')' + trailing;
      url = url.slice(0, -1);
      const innerPunct = url.match(TRAILING_PUNCTUATION);
      if (innerPunct) {
        trailing = innerPunct[0] + trailing;
        url = url.slice(0, url.length - innerPunct[0].length);
      }
    } else {
      break;
    }
  }

  while (url.endsWith(']')) {
    const openCount = (url.match(/\[/g) || []).length;
    const closeCount = (url.match(/\]/g) || []).length;
    if (closeCount > openCount) {
      trailing = ']' + trailing;
      url = url.slice(0, -1);
      const innerPunct = url.match(TRAILING_PUNCTUATION);
      if (innerPunct) {
        trailing = innerPunct[0] + trailing;
        url = url.slice(0, url.length - innerPunct[0].length);
      }
    } else {
      break;
    }
  }

  while (url.endsWith('}')) {
    const openCount = (url.match(/\{/g) || []).length;
    const closeCount = (url.match(/\}/g) || []).length;
    if (closeCount > openCount) {
      trailing = '}' + trailing;
      url = url.slice(0, -1);
      const innerPunct = url.match(TRAILING_PUNCTUATION);
      if (innerPunct) {
        trailing = innerPunct[0] + trailing;
        url = url.slice(0, url.length - innerPunct[0].length);
      }
    } else {
      break;
    }
  }

  return { url, trailing };
}

/**
 * Tokenizes plain text into literal text segments and safe web links.
 * Invariant: `parsePlainTextLinks(content).map((s) => s.text).join('') === content`
 */
export function parsePlainTextLinks(content: string): PlainTextSegment[] {
  if (!content) {
    return [];
  }

  const urlRegex = /https?:\/\/[^\s]+/gi;
  const segments: PlainTextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(content)) !== null) {
    const rawMatch = match[0];
    const matchIndex = match.index;

    const { url, trailing } = cleanTrailingUrlPunctuation(rawMatch);

    if (url && isSafeMarkdownLink(url)) {
      if (matchIndex > lastIndex) {
        segments.push({
          type: 'text',
          text: content.slice(lastIndex, matchIndex),
        });
      }

      segments.push({
        type: 'link',
        text: url,
        url,
      });

      lastIndex = matchIndex + url.length;
      urlRegex.lastIndex = lastIndex;
    }
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      text: content.slice(lastIndex),
    });
  }

  return segments;
}
