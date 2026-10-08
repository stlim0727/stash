import { isSafeMarkdownLink } from './markdown.ts';

export interface PlainTextSegment {
  type: 'text' | 'link';
  text: string;
  url?: string;
}

// Punctuation characters commonly appended to URLs in natural language,
// including ASCII and Unicode quotes, sentence enders, ellipses, and CJK punctuation.
const TRAILING_PUNCTUATION = /[.,;:!?"'<>…。，、；：！？“”‘’«»‹›]+$/u;

const BRACKET_PAIRS: [string, string][] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['（', '）'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['〈', '〉'],
];

// Prose punctuation delimiters that can separate adjacent URLs without whitespace.
const PROSE_DELIMITERS =
  '[.,;:!?"\'<>|\\\\^()\\[\\]{}…。，、；：！？“”‘’«»‹›（）【】「」『』《》〈〉]';
const URL_REGEX = new RegExp(
  `https?:\\/\\/(?:(?!${PROSE_DELIMITERS}+https?:\\/\\/)[^\\s])+`,
  'gi',
);

/**
 * Trims trailing punctuation from a matched URL while preserving balanced
 * parentheses, brackets, and braces (e.g. Wikipedia links or URLs wrapped in parens),
 * including smart quotes, ellipses, and CJK punctuation. Repeats pair cleanup after outer
 * closers are removed so nested wrappers (e.g. 『「...」』) are fully stripped.
 * Counts bracket pairs in linear time to avoid quadratic rescans on runs of closers.
 */
export function cleanTrailingUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = '';

  const stripPunct = () => {
    const punctMatch = url.match(TRAILING_PUNCTUATION);
    if (punctMatch) {
      trailing = punctMatch[0] + trailing;
      url = url.slice(0, url.length - punctMatch[0].length);
      return true;
    }
    return false;
  };

  // Pre-count bracket occurrences across rawUrl once in linear time.
  const pairCounts = BRACKET_PAIRS.map(([openChar, closeChar]) => {
    let openCount = 0;
    let closeCount = 0;
    for (let i = 0; i < rawUrl.length; i++) {
      if (rawUrl[i] === openChar) openCount++;
      else if (rawUrl[i] === closeChar) closeCount++;
    }
    return { openCount, closeCount };
  });

  let changed = true;
  while (changed) {
    changed = stripPunct();
    for (let i = 0; i < BRACKET_PAIRS.length; i++) {
      const [, closeChar] = BRACKET_PAIRS[i];
      const counts = pairCounts[i];
      if (counts.closeCount > counts.openCount && url.endsWith(closeChar)) {
        let endIndex = url.length;
        while (
          endIndex >= closeChar.length &&
          url.slice(endIndex - closeChar.length, endIndex) === closeChar
        ) {
          endIndex -= closeChar.length;
        }
        const runCount = Math.floor((url.length - endIndex) / closeChar.length);
        const excess = counts.closeCount - counts.openCount;
        const countToRemove = Math.min(runCount, excess);
        if (countToRemove > 0) {
          const charsToRemove = countToRemove * closeChar.length;
          trailing = url.slice(url.length - charsToRemove) + trailing;
          url = url.slice(0, url.length - charsToRemove);
          counts.closeCount -= countToRemove;
          changed = true;
          break;
        }
      }
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

  const urlRegex = new RegExp(URL_REGEX.source, URL_REGEX.flags);
  const segments: PlainTextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(content)) !== null) {
    const rawMatch = match[0];
    const matchIndex = match.index;

    const { url } = cleanTrailingUrlPunctuation(rawMatch);

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
