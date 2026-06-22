// Placeholder enrichment provider: deterministic keyword heuristics over a
// bookmark's URL/title/notes, with zero network calls. It exists so the whole
// auto-tagging pipeline — edge function, sync, accept/dismiss UI — can be
// built and shipped before a real model is wired in. Replace it by writing a
// new EnrichmentProvider and pointing index.ts at that instead.

import type {
  EnrichmentInput,
  EnrichmentOutput,
  EnrichmentProvider,
  SuggestedTag,
} from './provider.ts';

interface Rule {
  tag: string;
  /** Optional collection-name hint when this rule fires. */
  collection?: string;
  keywords: string[];
}

// Order matters: earlier rules are considered higher-priority and decay
// slightly later in the confidence calculation, keeping output deterministic.
const RULES: Rule[] = [
  {
    tag: 'programming',
    collection: 'Development',
    keywords: [
      'github.com', 'gitlab', 'stackoverflow', 'npmjs', 'typescript',
      'javascript', 'python', 'rust', 'golang', 'react', 'node',
    ],
  },
  {
    tag: 'design',
    collection: 'Design',
    keywords: ['figma', 'dribbble', 'behance', 'design', 'typography', 'ux', 'ui '],
  },
  {
    tag: 'video',
    collection: 'Watch later',
    keywords: ['youtube', 'youtu.be', 'vimeo', 'twitch', 'video', 'watch'],
  },
  {
    tag: 'reading',
    collection: 'Reading',
    keywords: ['medium.com', 'substack', 'blog', 'article', 'essay', 'newsletter'],
  },
  {
    tag: 'research',
    collection: 'Research',
    keywords: ['arxiv', 'researchgate', 'paper', 'journal', '.edu'],
  },
  { tag: 'news', keywords: ['reuters', 'bbc.', 'nytimes', 'cnn.', 'theguardian'] },
  {
    tag: 'reference',
    collection: 'Reference',
    keywords: ['docs.', 'documentation', 'reference', 'wiki', 'developer.mozilla'],
  },
  { tag: 'shopping', keywords: ['amazon.', 'etsy', '/shop', 'store', 'product', '/buy'] },
  {
    tag: 'social',
    keywords: ['twitter', 'x.com', 'reddit', 'news.ycombinator', 'linkedin', 'mastodon'],
  },
];

const MAX_TAGS = 5;

// Mirror of the app's surface threshold (domain/ai-suggestions.ts ->
// SUGGESTION_MIN_CONFIDENCE). A tag below this is hidden by both the Inbox
// "✨ N" badge and the Bookmark Detail card, so the provider must not emit it
// or claim it in the summary — otherwise the row says "review the tags below"
// while the client shows none. Kept in sync by hand across the edge/app seam.
const SURFACE_MIN_CONFIDENCE = 0.6;

// Localized labels for the heuristic rule tags, so the fallback also answers in
// the user's language (M12). Only the rule tags above are translated; the
// collection hint stays English so it still matches the user's existing
// collection names — same reasoning as the Gemini provider.
const TAG_LABELS: Record<string, Record<string, string>> = {
  ko: {
    programming: '프로그래밍',
    design: '디자인',
    video: '비디오',
    reading: '읽을거리',
    research: '연구',
    news: '뉴스',
    reference: '참고자료',
    shopping: '쇼핑',
    social: '소셜',
  },
};

/** Resolve the active locale's base subtag (e.g. 'ko-KR' → 'ko'), or '' when
 *  none/unknown so callers fall through to the English defaults. */
function localeBase(locale: string | null | undefined): string {
  if (!locale) {
    return '';
  }
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return base in TAG_LABELS ? base : '';
}

/** Translate a heuristic rule tag for the locale, defaulting to the English
 *  tag when there is no mapping (or the locale is English/unknown). */
function localizeTag(tag: string, base: string): string {
  return (base && TAG_LABELS[base]?.[tag]) || tag;
}

function hostOf(url: string | null): string {
  if (!url) {
    return '';
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export class DummyProvider implements EnrichmentProvider {
  readonly model = 'dummy-v0';

  // eslint-disable-next-line @typescript-eslint/require-await
  async enrich(input: EnrichmentInput): Promise<EnrichmentOutput> {
    const host = hostOf(input.url);
    const haystack = [
      input.url,
      input.title,
      input.description,
      input.notes,
      input.site_name,
      host,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .toLowerCase();

    const base = localeBase(input.locale);

    const matched = RULES.map((rule, index) => ({
      rule,
      index,
      hits: rule.keywords.filter((keyword) => haystack.includes(keyword)).length,
    })).filter((entry) => entry.hits > 0);

    // Only keyword-rule matches become tags, and only those the app will
    // actually surface (>= SURFACE_MIN_CONFIDENCE). We deliberately do NOT
    // invent a host-derived fallback tag (e.g. "example.com" → "example") when
    // nothing matches, and we drop sub-threshold rule hits (e.g. a lone "blog"
    // keyword at 0.56) for the same reason: the client hides them, so emitting
    // them only bloats the row with noise and makes the summary promise tags
    // that never appear. A bare bookmark with no confident tag is fine; the
    // summary and degraded_reason still tell the user what happened, and an
    // empty tag list is honest about having nothing to suggest.
    const suggested_tags: SuggestedTag[] = matched
      .map(({ rule, index, hits }) => ({
        name: localizeTag(rule.tag, base),
        // More keyword hits → higher confidence; later rules decay slightly.
        confidence: round2(Math.min(0.9, 0.55 + 0.1 * hits - 0.03 * index)),
      }))
      .filter((tag) => tag.confidence >= SURFACE_MIN_CONFIDENCE)
      .slice(0, MAX_TAGS);

    const topics = matched.map((entry) => localizeTag(entry.rule.tag, base));
    const suggested_collection =
      matched.find((entry) => entry.rule.collection)?.rule.collection ?? null;

    const confidence = suggested_tags.length
      ? round2(
          suggested_tags.reduce((sum, tag) => sum + tag.confidence, 0) /
            suggested_tags.length,
        )
      : null;

    // Only point the user at the suggested tags when there is at least one to
    // review; otherwise the summary would promise tags the client never shows.
    const hasTags = suggested_tags.length > 0;
    const summary = input.url
      ? base === 'ko'
        ? `${host || '알 수 없는 사이트'}의 항목` +
          (input.title ? ` — “${input.title}”` : '') +
          `. ${this.model}이(가) 자동 분류했습니다.` +
          (hasTags ? ' 아래 제안 태그를 확인하세요.' : '')
        : `${capitalize(input.content_type)} from ${host || 'an unknown site'}` +
          (input.title ? ` — “${input.title}”` : '') +
          `. Auto-categorized by ${this.model}` +
          (hasTags ? '; review the suggested tags below.' : '.')
      : null;

    return { summary, topics, suggested_tags, suggested_collection, confidence };
  }
}
