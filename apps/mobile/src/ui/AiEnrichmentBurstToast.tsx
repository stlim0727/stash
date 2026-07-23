import { useEffect, useRef } from 'react';

import { useT } from '@/i18n';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Surfaces the "N bookmarks summarized & tagged" toast once a burst of
 * background auto-enrichments finishes (STASH #574 Phase 1). The store owns
 * deciding *whether* a completion is toast-worthy (2+ settled together — see
 * `AI_ENRICHMENT_BURST_TOAST_MIN`) and exposes it as `aiEnrichmentBurstToast`,
 * a `{ count, token }` value that changes (by `token`, a monotonic counter —
 * not just `count`, so two consecutive same-size bursts both re-fire this
 * effect) each time a new burst completes.
 *
 * Mirrors `share/share-confirm-handler.tsx`'s pattern: this store state lives
 * in `BookmarksProvider`, which sits *above* `CaptureToastProvider` in the
 * tree (see `app/_layout.tsx`), so the store can't call `useCaptureToast`
 * itself — a small watcher component below both providers bridges the two.
 *
 * Renders nothing; the toast lives in the shared `CaptureToastProvider`.
 */
export function AiEnrichmentBurstToast() {
  const { aiEnrichmentBurstToast, dismissAiEnrichmentBurstToast } = useBookmarks();
  const { show } = useCaptureToast();
  const t = useT();
  const lastToken = useRef<number | null>(null);

  useEffect(() => {
    if (!aiEnrichmentBurstToast || aiEnrichmentBurstToast.token === lastToken.current) {
      return;
    }
    lastToken.current = aiEnrichmentBurstToast.token;
    show(t('toast.aiEnrichmentBurst', { count: aiEnrichmentBurstToast.count }));
    dismissAiEnrichmentBurstToast();
  }, [aiEnrichmentBurstToast, dismissAiEnrichmentBurstToast, show, t]);

  return null;
}
