// Real enrichment provider backed by the Google Gemini API.
//
// Gemini is used because its free tier is the most usable for this job: a
// single structured-output call returns a note (summary), topics, suggested
// tags with confidences, and a collection routing hint — exactly the shape the
// rest of the pipeline already expects. The mobile client still never talks to
// the model: this runs inside the `ai-enrich` edge function (see index.ts),
// where the API key lives in `Deno.env` and never ships to the app.
//
// Like provider.ts this module is dependency-free and runtime-agnostic — it
// reads no environment and imports no Deno/Node APIs. The API key, model, and
// even the `fetch` implementation are injected through the constructor, so it
// runs unchanged inside Deno and is unit-testable under Node with a stubbed
// fetch (no network).

import type {
  EnrichmentInput,
  EnrichmentOutput,
  EnrichmentProvider,
  SuggestedTag,
} from './provider.ts';

/** Minimal slice of the global `fetch` signature this provider relies on, so a
 *  test can supply a stub without pulling in DOM/Deno lib types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GeminiProviderConfig {
  apiKey: string;
  /** Defaults to the cheapest free-tier-friendly Flash model (Flash-Lite). */
  model?: string;
  /** Override the API base (e.g. for a proxy). Defaults to the public endpoint. */
  baseUrl?: string;
  /** Abort the request after this many ms so a hung connection falls back to the
   *  heuristics promptly rather than blocking. Defaults to 15s. */
  timeoutMs?: number;
  /** Injected for testing; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TAGS = 5;

/** Human-readable language names for the locales the app ships, so the model is
 *  told plainly what language to write in. Unknown/absent locales fall through
 *  to English — the same fallback the rest of the app uses. */
const LOCALE_LANGUAGE: Record<string, string> = {
  en: 'English',
  ko: 'Korean (한국어)',
};

/** Resolve a request locale (e.g. 'ko', 'ko-KR') to a language name for the
 *  prompt, defaulting to English when unknown. Matches on the base subtag. */
function languageFor(locale: string | null | undefined): string {
  if (!locale) {
    return LOCALE_LANGUAGE.en;
  }
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return LOCALE_LANGUAGE[base] ?? LOCALE_LANGUAGE.en;
}

/** Build the system instruction for a request. The language directive lives
 *  here (not just in the user prompt) and up front, so the model treats it as
 *  authoritative: short keyword tags otherwise tend to come back in the source
 *  content's language (e.g. English tags for an English page) even when a
 *  trailing "write in Korean" line is present. */
function buildSystemInstruction(language: string): string {
  return [
    'You organize a user\'s saved bookmarks.',
    `Write the natural-language fields — summary, topics, and suggested_tags — in ${language}, regardless of the language of the bookmark's title, URL, site, or description. Translate the concepts into ${language}; do not copy words from the source language. (suggested_collection is the one exception — see below.)`,
    'Given a bookmark\'s metadata, assess its content and return:',
    '- summary: one or two neutral sentences describing what the bookmark is (a usable note). Null if there is too little to go on.',
    '- topics: a few short lowercase subject keywords.',
    '- suggested_tags: up to five short lowercase tags, each with a confidence from 0 to 1. If one of the provided existing tags fits the bookmark, reuse its exact name verbatim (do NOT translate it) rather than coining a near-duplicate — this keeps the user\'s tag vocabulary consolidated. Only invent a new tag (in the target language) when no existing tag fits.',
    '- suggested_collection: a single best-fit collection NAME for filing this bookmark. If one of the provided existing collections fits, copy its NAME verbatim (do NOT translate it). If none fit, propose a concise, reusable new collection name in Title Case (a broad theme, not a one-off). Use null only when the content is too sparse to categorize at all.',
    '- confidence: your overall confidence from 0 to 1.',
    'For topics and suggested_tags, use all supplied evidence: description, user notes, site name, content type, and meaningful URL path terms are as important as the title. When the title is generic, short, or brand-only, do not let it dominate; prefer the more specific non-title metadata.',
    'Base every field only on the supplied metadata. Do not fabricate specifics you were not given.',
  ].join('\n');
}

/** Gemini's responseSchema (OpenAPI subset) — forces well-formed JSON back. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', nullable: true },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    suggested_tags: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
        },
        required: ['name', 'confidence'],
      },
    },
    suggested_collection: { type: 'STRING', nullable: true },
    confidence: { type: 'NUMBER', nullable: true },
  },
  required: ['topics', 'suggested_tags'],
};

function clamp01(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(1, Math.max(0, n));
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Build the user-facing prompt from the bookmark fields we have. Omitting
 *  blank fields keeps the model from treating "null" as content. */
function buildPrompt(input: EnrichmentInput): string {
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    }
  };
  add('URL', input.url);
  add('Title', input.title);
  add('Description', input.description);
  add('User notes', input.notes);
  add('Site', input.site_name);
  lines.push(`Content type: ${input.content_type}`);
  lines.push(
    'Tagging guidance: derive tags from the combined metadata above, not just the title. Favor concrete concepts from description, notes, site, content type, and URL path when they add signal.',
  );
  if (input.collections && input.collections.length > 0) {
    lines.push(`Existing collections: ${input.collections.join(', ')}`);
  } else {
    lines.push('Existing collections: (none yet)');
  }
  // Surface the user's established vocabulary so the model reuses an existing
  // tag instead of minting a near-duplicate (the fragmentation this fix
  // targets). Most-used first, so the canonical tags lead if the list is long.
  if (input.existing_tags && input.existing_tags.length > 0) {
    lines.push(`Existing tags (reuse when one fits): ${input.existing_tags.join(', ')}`);
  }
  const language = languageFor(input.locale);
  // Ask for the free-text fields in the user's language. suggested_collection is
  // deliberately excluded: it must match an existing collection NAME verbatim
  // (resolved by exact name in the edge function), so translating it would break
  // the lookup. The JSON keys themselves stay English so parsing is unchanged.
  lines.push(`Write the summary, suggested_tags, and topics in ${language}.`);
  return `Assess this bookmark and return the structured fields.\n\n${lines.join('\n')}`;
}

/** Pull the model's JSON payload out of a generateContent response. */
function extractJsonText(payload: unknown): string {
  const candidates = (payload as { candidates?: unknown[] })?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = (first as { content?: { parts?: Array<{ text?: string }> } })
    ?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => p?.text ?? '').join('')
    : '';
  if (!text.trim()) {
    throw new Error('Gemini returned no content');
  }
  return text;
}

/** Coerce the parsed model JSON into a valid EnrichmentOutput, clamping
 *  confidences and capping tags. Never trusts the model to be well-behaved. */
function normalize(parsed: unknown): EnrichmentOutput {
  const obj = (parsed ?? {}) as Record<string, unknown>;

  const topics = Array.isArray(obj.topics)
    ? obj.topics.filter((t): t is string => typeof t === 'string' && Boolean(t.trim()))
        .map((t) => t.trim())
    : [];

  const suggested_tags: SuggestedTag[] = Array.isArray(obj.suggested_tags)
    ? obj.suggested_tags
        .map((raw) => {
          const tag = (raw ?? {}) as Record<string, unknown>;
          const name = nonEmpty(tag.name);
          return name ? { name, confidence: clamp01(tag.confidence) } : null;
        })
        .filter((t): t is SuggestedTag => t !== null)
        .slice(0, MAX_TAGS)
    : [];

  const confidence =
    obj.confidence === null || obj.confidence === undefined
      ? suggested_tags.length
        ? clamp01(
            suggested_tags.reduce((sum, t) => sum + t.confidence, 0) /
              suggested_tags.length,
          )
        : null
      : clamp01(obj.confidence);

  return {
    summary: nonEmpty(obj.summary),
    topics,
    suggested_tags,
    suggested_collection: nonEmpty(obj.suggested_collection),
    confidence,
  };
}

export class GeminiProvider implements EnrichmentProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: GeminiProviderConfig) {
    if (!config.apiKey) {
      throw new Error('GeminiProvider requires an apiKey');
    }
    this.apiKey = config.apiKey;
    const modelName = config.model?.trim() || DEFAULT_MODEL;
    this.model = `gemini:${modelName}`;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs =
      config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    // `fetch` is global in Deno and modern Node; fall back to it when present.
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    const resolved = config.fetchImpl ?? (globalFetch as FetchLike | undefined);
    if (!resolved) {
      throw new Error('GeminiProvider requires a fetch implementation');
    }
    this.fetchImpl = resolved;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentOutput> {
    const modelName = this.model.replace(/^gemini:/, '');
    const url = `${this.baseUrl}/models/${modelName}:generateContent`;
    const body = JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildSystemInstruction(languageFor(input.locale)) }],
      },
      contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    // Bound the whole exchange (connect + body read) with an abort timer so a
    // hung connection throws promptly and index.ts can fall back to the
    // heuristics, rather than blocking until the runtime kills the request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let ok: boolean;
    let status: number;
    let raw: string;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body,
        signal: controller.signal,
      });
      ok = res.ok;
      status = res.status;
      raw = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Gemini request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      throw new Error(`Gemini request failed (${status}): ${raw.slice(0, 500)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Gemini returned non-JSON response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonText(payload));
    } catch (err) {
      throw new Error(
        `Gemini content was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return normalize(parsed);
  }
}
