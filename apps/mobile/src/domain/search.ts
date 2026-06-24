import { collectionMatchKey } from '@/domain/collection-match';
import type { Bookmark } from '@/domain/types';

/**
 * Optional resolvers that pull fields not stored on the `Bookmark` row itself —
 * tag names and the parent collection name — from the store. Kept as callbacks
 * so `filterBookmarks` stays a pure domain function (no store import). Both are
 * optional, so callers without tag/collection context still compile.
 */
export interface SearchResolvers {
  tagNames?: (bookmark: Bookmark) => string[];
  collectionName?: (bookmark: Bookmark) => string | null | undefined;
}

/**
 * Normalize a single token to the same key `collectionMatchKey` uses: NFKC +
 * lowercase + strip everything that isn't a letter or digit. This absorbs case,
 * punctuation, spacing, width, and accent differences so a "대충" query still
 * matches (e.g. "watch later" -> ["watch","later"] both substring "watchlater").
 *
 * We normalize PER TOKEN and re-join the haystack with spaces (rather than
 * stripping non-alphanumerics from the whole string at once) on purpose:
 * collapsing the entire haystack would fuse adjacent words ("local manager" ->
 * "localmanager"), creating cross-word false-positive substring matches. Keeping
 * a separator between tokens preserves the existing word-boundary semantics so
 * "local manager" still returns 0 results, while punctuation inside a single
 * token ("watch-later") is still folded away.
 */
function normalizeToken(token: string): string {
  return collectionMatchKey(token);
}

function normalizeHaystack(value: string): string {
  return value
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ');
}

/**
 * Symbol-preserving fold: NFKC + lowercase only, keeping punctuation. Used for
 * query terms that are DEFINED by their symbols ("c++", "c#", ".net"). Those
 * terms must NOT go through `normalizeToken`, which would strip the symbols and
 * collapse them to a degenerate one/two-letter token ("c", "net") that substring-
 * matches almost everything (a single "c" lives inside every collapsed ".com"
 * URL). We still split on whitespace and re-join with spaces so a symbol query
 * can't fuse across words — the per-term whitespace boundary is preserved exactly
 * as in `normalizeHaystack`.
 */
function symbolHaystack(value: string): string {
  return value
    .split(/\s+/)
    .map((token) => token.normalize('NFKC').toLowerCase())
    .filter(Boolean)
    .join(' ');
}

/**
 * A query term is "symbol-bearing" when its raw (NFKC + lowercased) form still
 * contains characters that `normalizeToken` would strip, i.e. it carries meaning
 * in punctuation/symbols ("c++", "c#", ".net", "f#"). These match LITERALLY
 * against the symbol-preserving haystack instead of falling through to the broad
 * punctuation-stripped substring match.
 *
 * TRADE-OFF (product call, flagged not decided silently): because a symbol term
 * is matched literally, "c++" matches a field containing the text "c++" but does
 * NOT match a tag stored as the bare word "cpp", and vice versa. We accept this:
 * a user typing the symbol "++" clearly means the symbol form, and the cost of
 * NOT doing this is the P2 bug where "c++" returns the entire inbox. Aliasing
 * "c++"<->"cpp" would need an explicit synonym table, out of scope here.
 */
const SYMBOL_FOLD = /[^\p{L}\p{N}\s]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const SEPARATOR_SYMBOLS = /^[._-]+$/u;

function isSeparatorTerm(value: string): boolean {
  const chars = [...value];
  if (
    chars.length === 0 ||
    !LETTER_OR_NUMBER.test(chars[0] ?? '') ||
    !LETTER_OR_NUMBER.test(chars.at(-1) ?? '')
  ) {
    return false;
  }
  let symbolRun = '';
  for (const char of chars) {
    if (LETTER_OR_NUMBER.test(char) || /\s/u.test(char)) {
      if (symbolRun && !SEPARATOR_SYMBOLS.test(symbolRun)) {
        return false;
      }
      symbolRun = '';
    } else {
      symbolRun += char;
    }
  }
  return !symbolRun || SEPARATOR_SYMBOLS.test(symbolRun);
}

function rawTerm(token: string): { value: string; hasSymbol: boolean } {
  const value = token.normalize('NFKC').toLowerCase();
  return { value, hasSymbol: SYMBOL_FOLD.test(value) && !isSeparatorTerm(value) };
}

/**
 * Split a raw query into its two term kinds, exactly as {@link filterBookmarks}
 * does: ordinary tokens are normalized (NFKC + lowercase + punctuation-stripped),
 * symbol-bearing tokens ("c++", "c#", ".net") keep their symbols and match
 * literally. Factored out so the suggestion shelf and the results list tokenize a
 * query through ONE code path — there must be a single normalization source of
 * truth, or the shelf and the "Matches (N)" list could disagree about a match.
 */
function splitQueryTerms(query: string): { terms: string[]; symbolTerms: string[] } {
  const rawTokens = query.split(/\s+/).filter(Boolean);
  const symbolTerms: string[] = [];
  const terms: string[] = [];
  for (const token of rawTokens) {
    const raw = rawTerm(token);
    if (raw.hasSymbol) {
      symbolTerms.push(raw.value);
    } else {
      const normalized = normalizeToken(token);
      if (normalized) {
        terms.push(normalized);
      }
    }
  }
  return { terms, symbolTerms };
}

/** How well a candidate matched the query, best-match-first ranking signal. */
export type MatchRank = 'exact' | 'prefix' | 'substring' | 'none';

/**
 * Does a single candidate NAME (a tag name, folder name, or recent search
 * string) match the query, and — if so — how well? This is the suggestion
 * shelf's per-candidate predicate, and it is built on the SAME tokenizer and
 * normalization (`splitQueryTerms` → `normalizeToken` / `symbolHaystack`) that
 * {@link filterBookmarks} uses for a bookmark's label fields, so a tag/folder the
 * shelf surfaces for a query is provably one the results path would also match.
 * Do NOT re-implement normalization elsewhere — call this.
 *
 * Matching is the same AND-across-whitespace-tokens, substring-per-token rule the
 * results use (no fuzzy/typo tolerance — Phase 2 only filters user-authored
 * values, it never relaxes to fuzzy/AI matching). The rank refines a matched
 * candidate for ordering, comparing the whole (separator-collapsed) candidate
 * against the whole (separator-collapsed) query:
 *  - `exact`     — the collapsed candidate equals the collapsed query;
 *  - `prefix`    — the collapsed candidate starts with the collapsed query;
 *  - `substring` — it matched but is neither of the above;
 *  - `none`      — it did not match.
 */
export function matchesQuery(candidateName: string, query: string): MatchRank {
  const { terms, symbolTerms } = splitQueryTerms(query);
  if (terms.length === 0 && symbolTerms.length === 0) {
    return 'none';
  }
  const name = candidateName ?? '';
  // Normalized haystack (per-token normalize, space-joined) for ordinary terms;
  // symbol-preserving haystack for symbol terms — mirroring filterBookmarks.
  const haystack = normalizeHaystack(name);
  const symbolHay = symbolHaystack(name);

  const collapsedHaystack = haystack.replace(/ /g, '');
  const collapsedSymbolHaystack = symbolHay.replace(/ /g, '');
  const normalizedMatch = terms.every(
    (term) => haystack.includes(term) || collapsedHaystack.includes(term),
  );
  const symbolMatch = symbolTerms.every((term) => symbolHay.includes(term));
  if (!normalizedMatch || !symbolMatch) {
    return 'none';
  }

  // Rank on the separator-collapsed forms so "Design System" vs "designsystem"
  // compare as a clean exact/prefix. Symbol terms keep their symbols; ordinary
  // terms are punctuation-stripped — collapse each side the matching way.
  const collapsedName =
    symbolTerms.length > 0 && terms.length === 0
      ? collapsedSymbolHaystack
      : collapsedHaystack + collapsedSymbolHaystack;
  // Reconstruct the collapsed query in the same families so the comparison is
  // apples-to-apples (normalized query tokens then symbol query tokens).
  const collapsedQuery = `${terms.join('')}${symbolTerms.join('')}`;
  if (!collapsedQuery) {
    return 'substring';
  }
  // Use the normalized-only forms for exact/prefix when there are no symbol
  // terms (the common case), which keeps "des" → "design" a clean prefix.
  const nameKey = symbolTerms.length === 0 ? collapsedHaystack : collapsedName;
  const queryKey = symbolTerms.length === 0 ? terms.join('') : collapsedQuery;
  if (nameKey === queryKey) {
    return 'exact';
  }
  if (nameKey.startsWith(queryKey)) {
    return 'prefix';
  }
  return 'substring';
}

/**
 * Case-insensitive, punctuation-tolerant client-side search over the fields a
 * user remembers a bookmark by — title/description/notes/url/site_name plus
 * (when resolvers are supplied) tag names and the parent collection name.
 * Whitespace-separated query terms must all match (AND), each against any field.
 */
export function filterBookmarks(
  bookmarks: Bookmark[],
  query: string,
  resolvers?: SearchResolvers,
): Bookmark[] {
  const rawTokens = query.split(/\s+/).filter(Boolean);
  // Split query tokens into two kinds via the shared tokenizer (the SAME one the
  // suggestion shelf's `matchesQuery` uses — single normalization source of
  // truth). Symbol-bearing tokens ("c++", "c#", ".net") match LITERALLY against a
  // punctuation-preserving haystack; ordinary tokens are normalized
  // (punctuation-stripped) and keep the existing tolerant substring behavior. A
  // token like "c++" is therefore NOT also normalized to a broad "c" term — that
  // degenerate term is exactly the P2 bug being fixed.
  const { terms, symbolTerms } = splitQueryTerms(query);
  if (terms.length === 0 && symbolTerms.length === 0) {
    return bookmarks;
  }

  // A single-token (no-whitespace) query may additionally match a value whose
  // words have had their separators removed, so a user who types what they SEE
  // on screen WITHOUT spaces ("watchlater") still finds a stored "Watch Later".
  // This makes the punctuation tolerance bidirectional, but it is deliberately
  // limited two ways:
  //   - Single-token queries only. Collapsing for a MULTI-token query would fuse
  //     adjacent words and reintroduce cross-word false positives ("local
  //     manager" must stay 0).
  //   - LABEL fields only (title, site_name, tag names, collection name) — NOT
  //     prose (notes, description). Users type compact, no-space text for the
  //     short LABELS they see on screen; they don't do that for memo bodies, so
  //     collapsing prose would create unnatural cross-word hits (a "syncdesign"
  //     query matching a "sync design" note). Prose is matched with the normal
  //     space-separated haystack only.
  // Normalization (NFKC + lowercase + per-token punctuation strip, space kept as
  // the token separator) is identical for both groups; only the collapse
  // fallback differs.
  // The collapse fallback ("watchlater" -> "Watch Later") is for a single
  // whole-query token; it stays gated on the ORIGINAL token count so a query that
  // also carries a symbol term doesn't accidentally qualify.
  const collapsedQuery =
    rawTokens.length === 1 && terms.length === 1 ? terms[0] : null;

  return bookmarks.filter((bookmark) => {
    const labelFields: Array<string | null | undefined> = [
      bookmark.title,
      bookmark.site_name,
      ...(resolvers?.tagNames?.(bookmark) ?? []),
      resolvers?.collectionName?.(bookmark),
    ];
    const proseFields: Array<string | null | undefined> = [
      bookmark.description,
      bookmark.notes,
      bookmark.url,
    ];

    const presentLabels = labelFields.filter((value): value is string => Boolean(value));
    const presentProse = proseFields.filter((value): value is string => Boolean(value));

    const normalizedLabels = presentLabels.map(normalizeHaystack).filter(Boolean);
    const normalizedProse = presentProse.map(normalizeHaystack).filter(Boolean);
    const haystack = [...normalizedLabels, ...normalizedProse].join(' ');

    // Every NORMALIZED term must match, either directly in the punctuation-
    // stripped haystack or (single-token query, label fields only) via the
    // collapse fallback.
    const normalizedTermsMatch = terms.every((term) => {
      if (haystack.includes(term)) {
        return true;
      }
      if (collapsedQuery === term) {
        return normalizedLabels.some((field) => field.replace(/ /g, '').includes(term));
      }
      return false;
    });
    if (!normalizedTermsMatch) {
      return false;
    }

    // Every SYMBOL-bearing term must match LITERALLY against the punctuation-
    // preserving haystack — never the stripped one — so "c++" stays selective.
    if (symbolTerms.length > 0) {
      const symbolHay = [...presentLabels, ...presentProse].map(symbolHaystack).join(' ');
      return symbolTerms.every((term) => symbolHay.includes(term));
    }
    return true;
  });
}
