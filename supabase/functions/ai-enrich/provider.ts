// The AI enrichment seam. Everything that produces suggestions for a bookmark
// goes through an EnrichmentProvider, so swapping the placeholder heuristics
// for a real model-backed implementation later is a one-line change in
// index.ts — the edge function shell, the database write, and the mobile
// client all stay the same.
//
// This module is intentionally dependency-free and runtime-agnostic (no Deno,
// Node, React Native, or path-alias imports) so it can be unit-tested under
// Node and imported unchanged by the Deno edge function.

/** The bookmark fields a provider may reason about. Mirrors the columns the
 *  edge function selects; deliberately a plain shape, not the app's Bookmark. */
export interface EnrichmentInput {
  url: string | null;
  title: string | null;
  description: string | null;
  notes: string | null;
  site_name: string | null;
  content_type: string;
  /** The names of the user's existing collections, when known. A provider may
   *  use these to route a bookmark into one that already exists instead of
   *  inventing a new name. Optional: heuristic providers ignore it, and the
   *  caller still resolves `suggested_collection` to a real id (or null). */
  collections?: string[];
  /** The names of the user's existing tags (most-used first), when known. A
   *  provider should prefer reusing one of these verbatim over coining a
   *  near-duplicate, so a user's vocabulary stays consolidated instead of
   *  fragmenting into single-use synonyms. Optional: heuristic providers ignore
   *  it, and reuse is only ever a suggestion the user still reviews. */
  existing_tags?: string[];
  /** BCP-47-ish locale of the requesting user (e.g. 'en', 'ko'), so a
   *  model-backed provider can return the summary and tags in their language.
   *  Optional: heuristic providers ignore it and the caller defaults sensibly. */
  locale?: string;
}

export interface SuggestedTag {
  name: string;
  /** 0..1 — how confident the provider is in this tag. */
  confidence: number;
}

export interface EnrichmentOutput {
  summary: string | null;
  topics: string[];
  suggested_tags: SuggestedTag[];
  /** A collection NAME hint. The caller resolves it to one of the user's
   *  existing collections (or null) — providers never invent collection ids. */
  suggested_collection: string | null;
  /** 0..1 — overall confidence in the enrichment, or null when unknown. */
  confidence: number | null;
  /** Token counts from the underlying model call, for cost/usage tracking.
   *  Omitted by providers with no such notion (e.g. the heuristic fallback);
   *  a model-backed provider that made a real call but got no usage data back
   *  reports the individual fields as null rather than omitting the object. */
  usage?: {
    prompt_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
  } | null;
}

export interface EnrichmentProvider {
  /** Stored on the enrichment row so results are traceable to their source
   *  (e.g. 'dummy-v0', later 'claude-...'). */
  readonly model: string;
  enrich(input: EnrichmentInput): Promise<EnrichmentOutput>;
}
