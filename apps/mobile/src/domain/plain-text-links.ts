import { isSafeMarkdownLink } from './markdown.ts';

export interface PlainTextSegment {
  type: 'text' | 'link';
  text: string;
  url?: string;
}

// Punctuation characters commonly appended to URLs in natural language,
// including ASCII and Unicode quotes, sentence enders, and CJK punctuation.
const TRAILING_PUNCTUATION = /[.,;:!?"'<>。，、；：！？“”‘’«»‹›]+$/u;

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
  '[.,;:!?"\'<>|\\\\^()\\[\\]{}。，、；：！？“”‘’«»‹›（）【】「」『』《》〈〉]';
const URL_REGEX = new RegExp(
  `https?:\\/\\/(?:(?!${PROSE_DELIMITERS}+https?:\\/\\/)[^\\s])+`,
  'gi',
);

/**
 * Trims trailing punctuation from a matched URL while preserving balanced
 * parentheses, brackets, and braces (e.g. Wikipedia links or URLs wrapped in parens),
 * including smart quotes and CJK punctuation. Repeats pair cleanup after outer
 * closers are removed so nested wrappers (e.g. 『「...」』) are fully stripped.
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

  let changed = true;
  while (changed) {
    changed = stripPunct();
    for (const [openChar, closeChar] of BRACKET_PAIRS) {
      if (url.endsWith(closeChar)) {
        const openCount = url.split(openChar).length - 1;
        const closeCount = url.split(closeChar).length - 1;
        if (closeCount > openCount) {
          trailing = closeChar + trailing;
          url = url.slice(0, -closeChar.length);
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
