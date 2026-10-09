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
 * Multi-syllable Korean grammatical copulas, verb endings, and particles that
 * commonly attach to URLs in informal notes and memos (e.g. "...입니다", "...에서"),
 * requiring preceding ASCII to avoid stripping endings when they form actual path/query
 * components (e.g. ".../wiki/이다", ".../?q=보세요").
 */
const KOREAN_MULTI_SYLLABLE_PROSE =
  /(?<=[a-zA-Z0-9])(?:입니다|입니까|이었습니다|였습니다|이었다|였다|이라서|이라는|이다|이고|이나|이란|이라|이며|이면|하세요|바랍니다|가세요|보세요|가요|해요|돼요|되요|에서도|에서는|에게는|에게도|으로는|으로도|까지는|부터는|에서|에게|한테|으로|까지|부터|마저|조차|처럼|보다)$/;

/**
 * Single-syllable Korean grammatical particles that can attach directly to ASCII tokens
 * (such as shortlink slugs, IDs, or ports like ".../xyz로" or ".../123을"), but must NOT
 * be stripped when preceded by Hangul (e.g. ".../wiki/사과", ".../테헤란로", ".../여의도",
 * ".../search?q=iPhone케이스").
 */
const KOREAN_ASCII_ATTACHED_PARTICLES =
  /(?<=[a-zA-Z0-9])(?:은|는|이|가|을|를|에|로|와|과|의|도|만)$/;

/**
 * Known Korean Internationalized ccTLDs and gTLDs.
 */
const KOREAN_IDN_TLDS = '한국|닷컴|닷넷|삼성';

/**
 * Known URL shorteners and shortlink domains where a single-segment path is
 * an opaque alphanumeric identifier rather than human-authored content.
 */
const SHORTLINK_HOST_REGEX =
  /^(?:[^\s/@:]+@)?(?:(?:[a-z0-9-]+\.)*(?:goo\.gl|bit\.ly|t\.co|tinyurl\.com|is\.gd|buff\.ly|ow\.ly|naver\.me|kakao\.me|me2\.do))(?::\d+)?$/i;

/**
 * Punctuation characters in query or fragment values (and '!' in Wikipedia paths)
 * that represent valid URL data rather than trailing prose punctuation.
 */
const PRESERVE_TRAILING_PUNCT_REGEX =
  /(?:\/wiki\/[^\s/?#]+(?<![!.,;:?])!|(?:[^\s/?#]+\?[^\s#]+|#[^\s]+)(?<![!.,;:?])[!?,;])\s*$/i;

function shouldPreserveTrailingPunctuation(url: string): boolean {
  if (!url) return false;
  const lastChar = url[url.length - 1];
  if (lastChar !== '!' && lastChar !== '?' && lastChar !== ',' && lastChar !== ';') {
    return false;
  }
  return PRESERVE_TRAILING_PUNCT_REGEX.test(url);
}

const AUTH_KOREAN_PROSE_REGEX = new RegExp(
  `^(https?:\\/\\/(?:[^\\s/@:]+@)?[^\\s/:?#]+\\.(?:[a-zA-Z]{2,}|${KOREAN_IDN_TLDS})(?::\\d+)?)([가-힣].*)$`,
  'i',
);

/**
 * Trims trailing punctuation from a matched URL while preserving balanced
 * parentheses, brackets, and braces (e.g. Wikipedia links or URLs wrapped in parens),
 * including smart quotes, ellipses, and CJK punctuation. Repeats pair cleanup after outer
 * closers are removed so nested wrappers (e.g. 『「...」』) are fully stripped.
 * Counts bracket pairs in linear time to avoid quadratic rescans on runs of closers.
 * Also trims identified Korean prose suffixes (e.g. "...입니다", "...에서", ".../xyz로")
 * while strictly preserving legitimate Korean or mixed-language URL components (e.g.
 * ".../search?q=iPhone케이스", ".../search?q=Windows에서", ".../wiki/사과", ".../wiki/Yahoo!").
 */
export function cleanTrailingUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = '';

  const stripPunct = () => {
    if (shouldPreserveTrailingPunctuation(url)) {
      return false;
    }
    const punctMatch = url.match(TRAILING_PUNCTUATION);
    if (!punctMatch) {
      return false;
    }

    const matchedText = punctMatch[0];
    const urlBaseLen = url.length - matchedText.length;
    for (let i = matchedText.length - 1; i >= 0; i--) {
      const char = matchedText[i];
      if (char === '!' || char === '?' || char === ',' || char === ';') {
        const candidateUrl = url.slice(0, urlBaseLen + i + 1);
        if (shouldPreserveTrailingPunctuation(candidateUrl)) {
          const outerPunct = matchedText.slice(i + 1);
          if (outerPunct.length > 0) {
            trailing = outerPunct + trailing;
            url = url.slice(0, url.length - outerPunct.length);
            return true;
          }
          return false;
        }
      }
    }

    trailing = matchedText + trailing;
    url = url.slice(0, url.length - matchedText.length);
    return true;
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

  // Strip identified Korean prose suffixes (copulas, verb endings, and particles)
  // ONLY when following authority, a bare trailing slash, or an opaque shortlink slug.
  // Avoid treating suffixes as prose when they are inside an authored path, query,
  // or fragment component (e.g. ".../Windows에서", ".../search?q=Windows에서",
  // ".../wiki/이다", ".../item/MacBook프로").
  const hasQueryOrFragment = url.includes('?') || url.includes('#');
  const hostMatch = url.match(/^https?:\/\/([^/?#]+)/i);
  const host = hostMatch ? hostMatch[1] : '';
  const pathPart = url.replace(/^https?:\/\/[^/?#]+/i, '');
  const pathSegments = pathPart.split('/').filter(Boolean);
  const isShortlink = SHORTLINK_HOST_REGEX.test(host);
  const isAuthoredPath = pathSegments.length > 0 && !isShortlink;

  if (!hasQueryOrFragment && !isAuthoredPath) {
    const multiMatch = url.match(KOREAN_MULTI_SYLLABLE_PROSE);
    if (multiMatch) {
      trailing = multiMatch[0] + trailing;
      url = url.slice(0, -multiMatch[0].length);
    } else {
      const singleMatch = url.match(KOREAN_ASCII_ATTACHED_PARTICLES);
      if (singleMatch) {
        trailing = singleMatch[0] + trailing;
        url = url.slice(0, -singleMatch[0].length);
      }
    }
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

    // 2. Stop candidate URL before Korean prose following an ASCII domain, IDN ccTLD, or port before any path:
    // e.g. "https://keepory.app입니다/path" -> URL stops at "https://keepory.app",
    // "https://예시.한국입니다" -> URL stops at "https://예시.한국",
    // preserving source offsets without deleting from the middle of the candidate.
    if (/[가-힣]/.test(candidate)) {
      const authKoreanMatch = candidate.match(AUTH_KOREAN_PROSE_REGEX);
      if (authKoreanMatch) {
        candidate = authKoreanMatch[1];
      }
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
