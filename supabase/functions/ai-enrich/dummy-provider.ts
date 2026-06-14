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

    const matched = RULES.map((rule, index) => ({
      rule,
      index,
      hits: rule.keywords.filter((keyword) => haystack.includes(keyword)).length,
    })).filter((entry) => entry.hits > 0);

    const suggested_tags: SuggestedTag[] = matched
      .map(({ rule, index, hits }) => ({
        name: rule.tag,
        // More keyword hits → higher confidence; later rules decay slightly.
        confidence: round2(Math.min(0.9, 0.55 + 0.1 * hits - 0.03 * index)),
      }))
      .slice(0, MAX_TAGS);

    // Nothing matched: fall back to a low-confidence tag from the host label
    // (e.g. "example.com" → "example") so a bookmark is never left bare.
    if (suggested_tags.length === 0 && host) {
      const label = host.split('.').slice(-2, -1)[0] ?? host;
      suggested_tags.push({ name: label, confidence: 0.4 });
    }

    const topics = matched.map((entry) => entry.rule.tag);
    const suggested_collection =
      matched.find((entry) => entry.rule.collection)?.rule.collection ?? null;

    const confidence = suggested_tags.length
      ? round2(
          suggested_tags.reduce((sum, tag) => sum + tag.confidence, 0) /
            suggested_tags.length,
        )
      : null;

    const summary = input.url
      ? `${capitalize(input.content_type)} from ${host || 'an unknown site'}` +
        (input.title ? ` — “${input.title}”` : '') +
        `. Auto-categorized by ${this.model}; review the suggested tags below.`
      : null;

    return { summary, topics, suggested_tags, suggested_collection, confidence };
  }
}
