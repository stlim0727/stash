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
import { recordLog } from '@/observability/log-buffer';
import { trackBreadcrumb } from '@/observability/sentry';
import { canDismissAfterShare, dismissAfterShare } from '@/share/dismiss';
import { recordPendingShareConfirm } from '@/share/pending-confirm';
import { recordShareAttempt } from '@/share/share-diagnostics';
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
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
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
    fileCount: number;
    fileMimeTypes: string[];
  } | null>(null);
  // Guards against re-copying the same intent across renders before the reset
  // propagates; cleared once the intent goes away so a later share is captured.
  const capturedRef = useRef(false);
  // The native module can report an error without a usable share payload. Keep
  // that visible to monitoring, but suppress duplicate reports across renders.
  const reportedErrorRef = useRef<string | null>(null);
  // Cached post-share preference; refreshed whenever a share is handled so a
  // Settings change takes effect on the next share without blocking on storage.
  const behavior = useRef<ShareBehavior>(DEFAULT_SHARE_BEHAVIOR);

  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = null;
      return;
    }
    if (reportedErrorRef.current === error) {
      return;
    }
    reportedErrorRef.current = error;
    recordLog('error', '[share] native share intent error', [new Error(error)]);
    show(t('toast.noLink'));
    router.replace('/');
    resetShareIntent();
  }, [error, resetShareIntent, router, show, t]);

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
    // `webUrl` is expo-share-intent's best guess, but it can still be a value
    // our capture path rejects: a non-http scheme, or a link carrying interior
    // whitespace (a source app that appends a title after the URL, or a query
    // value with a space). `normalizeUrl` — which addBookmark runs — returns
    // null for those, so handing such a webUrl straight through made addBookmark
    // return `invalid`; the share was then dropped and, in toast mode, the app
    // dismissed back to the source app with nothing saved. Run BOTH candidates
    // through extractFirstUrl so share.url is always a normalized, saveable URL
    // or null — falling through to the text-note path below rather than losing
    // the capture. Capture is sacred.
    const url = extractFirstUrl(shareIntent.webUrl) ?? extractFirstUrl(shareIntent.text);
    // Keep the raw shared text so a no-link share (e.g. a KakaoTalk message)
    // can still be saved as a text note instead of being dropped.
    const text = shareIntent.text ?? undefined;
    // A shared image (e.g. a screenshot) — captured when there is no link.
    const image = pickSharedImage(shareIntent.files);
    // Shape-only file info (count + MIME types, never content) for the durable
    // share-attempt diagnostics recorded below once the outcome is known.
    const fileCount = shareIntent.files?.length ?? 0;
    const fileMimeTypes = (shareIntent.files ?? [])
      .map((file) => file?.mimeType)
      .filter((mime): mime is string => typeof mime === 'string' && mime.length > 0);
    setPendingShare({
      url,
      title: shareIntent.meta?.title ?? undefined,
      text,
      image,
      fileCount,
      fileMimeTypes,
    });
    // Coarse capture breadcrumb (kind of share only — never URL/title/text) so a
    // freeze right after a share (Sentry STASH-H) shows the share on the event
    // timeline that attaches to the loop-stall report.
    trackBreadcrumb('share', 'received', {
      hasUrl: url !== null,
      hasImage: image !== null,
      hasText: text !== undefined,
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
    const saveStartedAt = Date.now();
    const result = share.url
      ? addBookmark({ url: share.url, title: share.title })
      : share.image
        ? addBookmark({ image: share.image, title: share.title })
        : addBookmark({ shared_text: share.text, title: share.title });
    const saved = result.status !== 'invalid';
    // Only a genuinely new save is worth confirming on the next open; a
    // duplicate already lived in the library and a no-link share saved nothing.
    const isNewSave = result.status === 'created';
    // Durable record of this attempt's shape + outcome — survives an app
    // restart, unlike the in-memory log buffer, so a "Report a problem" filed
    // in a later session (after a silently failed share) still carries real
    // evidence instead of just that session's own unrelated startup logs.
    recordShareAttempt({
      hasUrl: share.url !== null,
      hasText: Boolean(share.text?.trim()),
      hasImage: share.image !== null,
      fileCount: share.fileCount,
      fileMimeTypes: share.fileMimeTypes,
      result: result.status,
    });
    if (saved) {
      message = result.status === 'duplicate' ? t('toast.duplicate') : t('toast.saved');
      persisted = result.persisted;
    }
    // Bracket the save so a post-share freeze can be tied to how long the durable
    // write took. Coarse only — status/duration/durability, never content.
    trackBreadcrumb('share', 'saving', { status: result.status });
    void persisted?.then(
      (durable) =>
        trackBreadcrumb('share', 'persisted', { ms: Date.now() - saveStartedAt, durable }),
      () => {},
    );

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
        // Jump to the Inbox only after a brand-new capture has durably landed.
        // Duplicate refreshes are best-effort bookkeeping for an already-saved
        // row, so they must not block the duplicate toast or Inbox navigation.
        const newCaptureFailed =
          result.status === 'created' && (await persisted) === false;
        show(newCaptureFailed ? t('toast.saveFailed') : message);
        if (!newCaptureFailed) {
          router.replace('/');
        }
        return;
      }

      // Toast mode: wait for the durable write, then dismiss Stash entirely
      // where the OS allows it (Android) so the user returns to the app they
      // shared from. Otherwise land on the Inbox rather than the stale
      // Detail/Settings screen the share happened to resume onto. The leaked
      // `stash://dataUrl=...` deep link is cleared by the +not-found absorber
      // regardless, so neither path strands the user.
      //
      // Only background the app once a capture has DURABLY landed. `saved` gates
      // the genuinely-empty share: with nothing captured, dismissing back to the
      // source app would just look like a silent failure, so land on the Inbox
      // and show the "no link" toast instead. When something was saved, the
      // durability gate still applies (`durable === false` means the row survives
      // only in memory — keep the user in-app). Capture is sacred.
      const durable = await persisted;
      if (saved && durable !== false) {
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
