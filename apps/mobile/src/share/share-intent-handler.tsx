import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';

import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from '@/domain/share-behavior';
import { extractFirstUrl } from '@/domain/urls';
import { getPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it through the existing store (which queues it
 * for sync) and confirm with the shared capture toast — never opening the full
 * editor and never waiting on the network.
 *
 * By default a share doesn't navigate: the toast is the whole interaction, so
 * it doesn't yank you into the Inbox. Users who prefer to land on the Inbox can
 * opt in via Settings (see `share-behavior`).
 *
 * Renders nothing (the toast lives in the shared `CaptureToastProvider`); the
 * native share module is a no-op on web.
 */
export function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { addBookmark, isLoading } = useBookmarks();
  const router = useRouter();
  const { show } = useCaptureToast();

  // A share copied out of expo-share-intent, held until the store has loaded.
  // We capture it immediately (and release the OS intent) so a
  // resetOnBackground — or the user backing out during a slow SQLite load —
  // can never drop a capture; the save itself waits for the store so dedupe
  // sees the bookmarks already on the device. Capture is sacred.
  const [pendingShare, setPendingShare] = useState<{ url: string | null; title?: string } | null>(
    null,
  );
  // Guards against re-copying the same intent across renders before the reset
  // propagates; cleared once the intent goes away so a later share is captured.
  const capturedRef = useRef(false);
  // Cached post-share preference; refreshed whenever a share is handled so a
  // Settings change takes effect on the next share without blocking on storage.
  const behavior = useRef<ShareBehavior>(DEFAULT_SHARE_BEHAVIOR);

  // Copy the incoming share into local state right away, then release the OS
  // intent so nothing else can clear it while we wait for the store to load.
  useEffect(() => {
    if (!hasShareIntent) {
      capturedRef.current = false;
      return;
    }
    if (capturedRef.current) {
      return;
    }
    capturedRef.current = true;
    setPendingShare({
      url: shareIntent.webUrl ?? extractFirstUrl(shareIntent.text),
      title: shareIntent.meta?.title ?? undefined,
    });
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  // Save once the store has loaded, so the in-memory dedupe sees existing
  // bookmarks instead of running against an empty set during the cold start.
  useEffect(() => {
    if (!pendingShare || isLoading) {
      return;
    }
    if (pendingShare.url) {
      const result = addBookmark({ url: pendingShare.url, title: pendingShare.title });
      show(result.status === 'duplicate' ? 'Already in Stash' : 'Saved to Stash');
      // Respect the user's post-share preference: by default the toast is the
      // whole interaction and we stay put; only jump to the Inbox when opted
      // in. The leaked `stash://dataUrl=...` deep link is cleared by the global
      // +not-found absorber regardless, so toast mode never strands the user.
      getPreference(SHARE_BEHAVIOR_PREF_KEY)
        .then((raw) => {
          behavior.current = parseShareBehavior(raw);
          if (behavior.current === 'inbox') {
            router.replace('/');
          }
        })
        .catch(() => {});
    } else {
      show('No link found to stash');
    }
    setPendingShare(null);
  }, [pendingShare, isLoading, addBookmark, router, show]);

  return null;
}
