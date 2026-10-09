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
const PROSE_DELIMITER_CHARS = new Set(
  '.,;:!?"\'<>|\\^()[]{}…。，、；：！？“”‘’«»‹›（）【】「」『』《》〈〉'.split(''),
);

/**
 * Trims trailing punctuation from a matched URL while preserving balanced
 * parentheses, brackets, and braces (e.g. Wikipedia links or URLs wrapped in parens),
 * including smart quotes, ellipses, and CJK punctuation. Repeats pair cleanup after outer
 * closers are removed so nested wrappers (e.g. 『「...」』) are fully stripped.
 * Counts bracket pairs in linear time to avoid quadratic rescans on runs of closers.
 * Also trims attached Korean prose suffixes (e.g. "입니다", "을") when attached to ASCII tokens.
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

  // Strip attached Korean prose suffixes (e.g. /xyz입니다 or https://keepory.app입니다)
  // only when attached immediately to an ASCII letter, digit, or port.
  // This preserves legitimate Korean URL words/paths such as /wiki/사과 or /wiki/대한민국.
  const asciiAttachedMatch = url.match(/^(.+[a-zA-Z0-9])([가-힣]+)$/);
  if (asciiAttachedMatch) {
    trailing = asciiAttachedMatch[2] + trailing;
    url = asciiAttachedMatch[1];
  }

  stripPunct();

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
    let candidate = match[0];
    const matchIndex = match.index;

    // 1. Single-pass adjacent URL split at prose delimiters (avoids quadratic lookahead).
    const protoMatch = candidate.match(/^https?:\/\//i);
    const protoLen = protoMatch ? protoMatch[0].length : 8;
    const nextProtoOffset = candidate.slice(protoLen).search(/https?:\/\//i);
    if (nextProtoOffset !== -1) {
      const nextProtoIndex = protoLen + nextProtoOffset;
      let delimStart = nextProtoIndex;
      while (delimStart > 0 && PROSE_DELIMITER_CHARS.has(candidate[delimStart - 1])) {
        delimStart--;
      }
      if (delimStart < nextProtoIndex && delimStart > 0) {
        candidate = candidate.slice(0, delimStart);
      }
    }

    // 2. Stop candidate URL before Korean prose following an ASCII domain/port before any path:
    // e.g. "https://keepory.app입니다/path" -> URL stops at "https://keepory.app",
    // preserving source offsets without deleting from the middle of the candidate.
    const authKoreanMatch = candidate.match(
      /^(https?:\/\/(?:[^\s/@:]+@)?[^\s/:?#]+\.[a-zA-Z]{2,}(?::\d+)?)([가-힣].*)$/,
    );
    if (authKoreanMatch) {
      candidate = authKoreanMatch[1];
    }

    // 3. Clean trailing punctuation, bracket pairs, and Korean prose suffixes in linear time.
    const { url } = cleanTrailingUrlPunctuation(candidate);

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
