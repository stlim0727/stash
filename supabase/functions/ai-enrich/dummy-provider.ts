// Empty fallback provider: returns no suggestions at all, with zero network
// calls. It exists purely as the thing the edge function falls back *to* when a
// real model (see gemini-provider.ts) isn't configured or a live call fails —
// the pipeline still records that enrichment ran and, via `degraded_reason`,
// why it was thin.
//
// It used to run keyword→category heuristics (github → "programming", youtube →
// "video", …), but those broad, obvious tags were low-value noise: they told
// the user nothing they didn't already know, and a paying user reads them as
// filler. So the provider now deliberately suggests nothing rather than pad the
// bookmark with throwaway tags/folders the user only has to dismiss. The
// genuinely useful offline signal — hashtags the user actually wrote into the
// content — lives in the app (domain/hashtags.ts) and is independent of this.
//
// Replace it by writing a real EnrichmentProvider and pointing index.ts at that.

import type { EnrichmentOutput, EnrichmentProvider } from './provider.ts';

export class DummyProvider implements EnrichmentProvider {
  readonly model = 'dummy-v0';

  // eslint-disable-next-line @typescript-eslint/require-await
  async enrich(): Promise<EnrichmentOutput> {
    // Nothing to say. The caller still writes a row and sets `degraded` +
    // `degraded_reason`, which is the honest signal; an empty result is honest
    // about having no suggestions rather than inventing ones.
    return {
      summary: null,
      topics: [],
      suggested_tags: [],
      suggested_collection: null,
      confidence: null,
    };
  }
}
