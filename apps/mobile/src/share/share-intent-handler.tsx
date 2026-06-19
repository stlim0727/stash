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
import { returnToPreviousApp, showSystemToast } from '@/share/return-to-app';
import { getPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it through the existing store (which queues it
 * for sync) and confirm — never opening the full editor and never waiting on
 * the network.
 *
 * By default (toast mode) a share is fire-and-forget: we don't navigate, and on
 * Android — where `expo-share-intent` has no choice but to foreground Stash to
 * hand off the URL — we confirm with a floating OS toast and drop straight back
 * to the app the share came from, so capturing doesn't yank you into Stash.
 * (iOS can't background itself, so there we just show the in-app toast.) Users
 * who prefer to land on the Inbox can opt in via Settings (see `share-behavior`).
 *
 * Renders nothing (the in-app toast lives in the shared `CaptureToastProvider`);
 * the native share module is a no-op on web.
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

    const message = pendingShare.url
      ? addBookmark({ url: pendingShare.url, title: pendingShare.title }).status === 'duplicate'
        ? 'Already in Stash'
        : 'Saved to Stash'
      : 'No link found to stash';

    // Confirm and react per the user's post-share preference. We read it now
    // (rather than caching) so a Settings change takes effect on the next share.
    // The leaked `stash://dataUrl=...` deep link is cleared by the global
    // +not-found absorber regardless, so no path strands the user.
    getPreference(SHARE_BEHAVIOR_PREF_KEY)
      .then((raw) => confirmShare(message, parseShareBehavior(raw)))
      .catch(() => confirmShare(message, DEFAULT_SHARE_BEHAVIOR));

    setPendingShare(null);

    function confirmShare(text: string, behavior: ShareBehavior) {
      if (behavior === 'inbox') {
        // Opted in to landing on the Inbox: stay in Stash and show the in-app
        // toast there, then navigate to the freshly stashed item.
        show(text);
        router.replace('/');
        return;
      }
      // Toast mode (default): fire-and-forget. On Android, surface a floating OS
      // toast and step back to the app the share came from; everywhere else the
      // app can't background itself, so fall back to the in-app toast.
      if (showSystemToast(text)) {
        returnToPreviousApp();
      } else {
        show(text);
      }
    }
  }, [pendingShare, isLoading, addBookmark, router, show]);

  return null;
}
