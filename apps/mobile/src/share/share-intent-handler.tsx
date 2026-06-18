import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';

import { extractFirstUrl } from '@/domain/urls';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it through the existing store (which queues it
 * for sync) and confirm with the shared capture toast — never opening the full
 * editor and never waiting on the network. The native module is a no-op on web.
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
      // Land on Inbox so the freshly stashed item is visible; this is not a
      // full editor, matching the fast-capture requirement.
      router.replace('/');
    } else {
      show('No link found to stash');
    }
    setPendingShare(null);
  }, [pendingShare, isLoading, addBookmark, router, show]);

  return null;
}
