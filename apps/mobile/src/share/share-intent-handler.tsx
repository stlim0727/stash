import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';

import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from '@/domain/share-behavior';
import { pickSharedImage, type SharedImage } from '@/domain/image-share';
import { extractFirstUrl } from '@/domain/urls';
import { useT } from '@/i18n';
import { canDismissAfterShare, dismissAfterShare } from '@/share/dismiss';
import { recordPendingShareConfirm } from '@/share/pending-confirm';
import { getPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it through the existing store (which queues it
 * for sync) and confirm with the shared capture toast — never opening the full
 * editor and never waiting on the network.
 *
 * By default (toast mode) a share gets straight back out of the way: it does
 * not yank you into the Inbox, and — crucially — it never leaves you stranded
 * on the stale Bookmark Detail or Settings screen the app happened to resume
 * onto. On Android we dismiss Stash entirely so you return to the app you
 * shared from (the closest we can get to "don't show Stash at all"); where the
 * OS won't let the app self-dismiss we land on the Inbox, a clean and relevant
 * screen. Users who prefer to always jump to the Inbox can opt in via Settings
 * (see `share-behavior`).
 *
 * Renders nothing (the toast lives in the shared `CaptureToastProvider`); the
 * native share module is a no-op on web.
 */
export function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { addBookmark, isLoading } = useBookmarks();
  const router = useRouter();
  const { show } = useCaptureToast();
  const t = useT();

  // A share copied out of expo-share-intent, held until the store has loaded.
  // We capture it immediately (and release the OS intent) so a
  // resetOnBackground — or the user backing out during a slow SQLite load —
  // can never drop a capture; the save itself waits for the store so dedupe
  // sees the bookmarks already on the device. Capture is sacred.
  const [pendingShare, setPendingShare] = useState<{
    url: string | null;
    title?: string;
    text?: string;
    image: SharedImage | null;
  } | null>(null);
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
      // Keep the raw shared text so a no-link share (e.g. a KakaoTalk message)
      // can still be saved as a text note instead of being dropped.
      text: shareIntent.text ?? undefined,
      // A shared image (e.g. a screenshot) — captured when there is no link.
      image: pickSharedImage(shareIntent.files),
    });
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  // Save once the store has loaded, so the in-memory dedupe sees existing
  // bookmarks instead of running against an empty set during the cold start.
  useEffect(() => {
    if (!pendingShare || isLoading) {
      return;
    }
    const share = pendingShare;
    // Clear right away so a re-render can't double-handle the same capture.
    setPendingShare(null);

    let message = t('toast.noLink');
    let persisted: Promise<boolean> | undefined;
    // Save the link when there is one; otherwise capture a shared image, and
    // failing that fall back to saving the shared text as a note. addBookmark
    // returns 'invalid' only when there is none of the three, which keeps the
    // "nothing to save" toast for a genuinely empty share.
    const result = share.url
      ? addBookmark({ url: share.url, title: share.title })
      : share.image
        ? addBookmark({ image: share.image, title: share.title })
        : addBookmark({ shared_text: share.text, title: share.title });
    // Only a genuinely new save is worth confirming on the next open; a
    // duplicate already lived in the library and a no-link share saved nothing.
    const isNewSave = result.status === 'created';
    if (result.status !== 'invalid') {
      message = result.status === 'duplicate' ? t('toast.duplicate') : t('toast.saved');
      persisted = result.persisted;
    }

    // Resolve the post-share behavior, then either jump to the Inbox (inbox
    // mode) or get back out of the way (toast mode). Reading the preference is
    // async, which conveniently lets toast mode also await the durable write
    // before tearing the app down so backgrounding can never cut off an
    // in-flight capture. Capture is sacred.
    void (async () => {
      let behaviorPref = DEFAULT_SHARE_BEHAVIOR;
      try {
        behaviorPref = parseShareBehavior(await getPreference(SHARE_BEHAVIOR_PREF_KEY));
      } catch {
        // Storage hiccup — fall back to the default behavior.
      }
      behavior.current = behaviorPref;

      if (behaviorPref === 'inbox') {
        // Jump to the Inbox so the freshly stashed item is immediately visible.
        show(message);
        router.replace('/');
        return;
      }

      // Toast mode: wait for the durable write, then dismiss Stash entirely
      // where the OS allows it (Android) so the user returns to the app they
      // shared from. Otherwise land on the Inbox rather than the stale
      // Detail/Settings screen the share happened to resume onto. The leaked
      // `stash://dataUrl=...` deep link is cleared by the +not-found absorber
      // regardless, so neither path strands the user.
      //
      // Crucially, only background the app once the capture is DURABLY written
      // (`persisted === true`). If the write failed, the row lives only in
      // optimistic in-memory state, so exiting would lose it — keep the user
      // in-app instead. `undefined` means nothing was saved (no link), which is
      // safe to dismiss on. Capture is sacred.
      const durable = await persisted;
      if (durable !== false) {
        // Persist the "confirm on next open" record BEFORE we hand control back
        // to the other app — the same reason we awaited the durable write
        // above. `dismissAfterShare` calls `exitApp()` synchronously, so a
        // fire-and-forget write here could be cut off and leave the reopened
        // app with nothing to confirm. Only record it when the app will
        // actually self-dismiss (Android): on iOS/web we fall through to an
        // in-app toast + Inbox below, which already confirms the save, so a
        // record there would surface a stale "saved" toast on the next launch.
        if (isNewSave && canDismissAfterShare()) {
          await recordPendingShareConfirm();
        }
        if (dismissAfterShare(message)) {
          return;
        }
      }
      show(message);
      router.replace('/');
    })();
  }, [pendingShare, isLoading, addBookmark, router, show, t]);

  return null;
}
