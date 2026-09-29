import { useRouter } from 'expo-router';
import { ShareIntentModule, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { Platform, AppState } from 'react-native';

import { consumeNativePendingShares } from './native-pending-shares';

import { useAnalytics } from '@/analytics/provider';
import { createCaptureCompletedEvent } from '@/analytics/events';

import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from '@/domain/share-behavior';
import { pickSharedImage, type SharedImage } from '@/domain/image-share';
import { compareShareAttemptUrls } from '@/domain/share-diagnostics';
import { extractFirstUrl } from '@/domain/urls';
import { useT } from '@/i18n';
import { recordLog } from '@/observability/log-buffer';
import { trackBreadcrumb } from '@/observability/sentry';
import { canDismissAfterShare, dismissAfterShare } from '@/share/dismiss';
import { recordPendingShareConfirm, takePendingShareConfirm } from '@/share/pending-confirm';
import { recordShareAttempt, recordSharePersistence } from '@/share/share-diagnostics';
import { getPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { useCaptureToast } from '@/ui/capture-toast';

let jsAttemptSequence = 0;

function nextJsAttemptId(): string {
  jsAttemptSequence += 1;
  return `js-${Date.now()}-${jsAttemptSequence}`;
}

function nativeCaptureClientId(attemptId: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    attemptId,
  )
    ? attemptId
    : undefined;
}

function nativeErrorAttemptId(error: string): string | undefined {
  const match = /\s\[attemptId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]$/i.exec(error);
  return match?.[1];
}

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
  const analytics = useAnalytics();
  const router = useRouter();
  const { show } = useCaptureToast();
  const t = useT();

  // A share copied out of expo-share-intent, held until the store has loaded.
  // We capture it immediately (and release the OS intent) so a
  // resetOnBackground — or the user backing out during a slow SQLite load —
  // can never drop a capture; the save itself waits for the store so dedupe
  // sees the bookmarks already on the device. Capture is sacred.
  const [pendingShare, setPendingShare] = useState<{
    attemptId: string;
    receivedAt: string;
    url: string | null;
    title?: string;
    text?: string;
    image: SharedImage | null;
    fileCount: number;
    fileMimeTypes: string[];
    urlSource: 'web_url' | 'text' | 'none';
    urlCandidatesMatch?: boolean;
    sameUrlAsPreviousAttempt?: boolean;
  } | null>(null);
  // Guards against re-copying the same intent across renders before the reset
  // propagates; cleared once the intent goes away so a later share is captured.
  const capturedRef = useRef(false);
  // Keep only the previous normalized URL in memory long enough to compare a
  // follow-up share. Diagnostics persist the comparison boolean, never either
  // URL, so a STASH-6B-style "duplicate, then retry created" report can tell a
  // real same-link retry from two different shares without leaking content.
  const previousShareUrlRef = useRef<string | null>(null);
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
    const attemptId = nativeErrorAttemptId(error);
    if (attemptId && typeof ShareIntentModule?.acknowledgeShareIntent === 'function') {
      // Parser errors cannot become durable capture work. Retire them after
      // recording diagnostics; durable save errors stay replayable.
      void ShareIntentModule.acknowledgeShareIntent(attemptId).catch(() => {});
    }
    show(t('toast.noLink'));
    router.replace('/');
    resetShareIntent();
  }, [error, resetShareIntent, router, show, t]);

  // Purely observational native-side debug logging (Sentry STASH-2K), kept
  // deliberately separate from the `onError`-driven `error` handling above:
  // `onError` drives the toast/reset/navigate flow, but this event must never
  // trigger any behavior — only get durably logged so a later "Report a
  // problem" can show whether a suspected native code path actually ran.
  useEffect(() => {
    const subscription = ShareIntentModule?.addListener('onDebugLog', (event) => {
      recordLog('info', `[share] native debug: ${event.value}`);
    });
    return () => subscription?.remove();
  }, []);

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
    const webUrlCandidate = extractFirstUrl(shareIntent.webUrl);
    const textUrlCandidate = extractFirstUrl(shareIntent.text);
    const url = webUrlCandidate ?? textUrlCandidate;
    const previousUrl = previousShareUrlRef.current;
    previousShareUrlRef.current = url;
    const sameUrlAsPreviousAttempt = compareShareAttemptUrls(url, previousUrl);
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
      attemptId: shareIntent.meta?.attemptId ?? nextJsAttemptId(),
      receivedAt: new Date().toISOString(),
      url,
      title: shareIntent.meta?.title ?? undefined,
      text,
      image,
      fileCount,
      fileMimeTypes,
      urlSource: webUrlCandidate ? 'web_url' : textUrlCandidate ? 'text' : 'none',
      ...(webUrlCandidate && textUrlCandidate
        ? { urlCandidatesMatch: webUrlCandidate === textUrlCandidate }
        : {}),
      ...(typeof sameUrlAsPreviousAttempt === 'boolean' ? { sameUrlAsPreviousAttempt } : {}),
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
    const captureClientId = nativeCaptureClientId(share.attemptId);
    const result = share.url
      ? addBookmark({
          url: share.url,
          title: share.title,
          title_is_derived: true,
          // Find a prior attempt even if its URL was later edited or trashed.
          capture_client_id: captureClientId,
        })
      : share.image
        ? addBookmark({ image: share.image, title: share.title, capture_client_id: captureClientId })
        : addBookmark({
            shared_text: share.text,
            title: share.title,
            capture_client_id: captureClientId,
          });
    const saved = result.status !== 'invalid';
    // Only a genuinely new save is worth confirming on the next open; a
    // duplicate already lived in the library and a no-link share saved nothing.
    const isNewSave = result.status === 'created';
    // Durable record of this attempt's shape + outcome — survives an app
    // restart, unlike the in-memory log buffer, so a "Report a problem" filed
    // in a later session (after a silently failed share) still carries real
    // evidence instead of just that session's own unrelated startup logs.
    recordShareAttempt({
      attemptId: share.attemptId,
      receivedAt: share.receivedAt,
      hasUrl: share.url !== null,
      hasText: Boolean(share.text?.trim()),
      hasImage: share.image !== null,
      fileCount: share.fileCount,
      fileMimeTypes: share.fileMimeTypes,
      result: result.status,
      urlSource: share.urlSource,
      ...(typeof share.urlCandidatesMatch === 'boolean'
        ? { urlCandidatesMatch: share.urlCandidatesMatch }
        : {}),
      ...(typeof share.sameUrlAsPreviousAttempt === 'boolean'
        ? { sameUrlAsPreviousAttempt: share.sameUrlAsPreviousAttempt }
        : {}),
      // How long this share sat waiting on the cold-start store load before it
      // could be processed (Sentry STASH-2T/STASH-2V: a "shared but nothing
      // saved, no toast" report with no evidence of what actually happened).
      loadWaitMs: saveStartedAt - new Date(share.receivedAt).getTime(),
    });
    if (saved) {
      message = result.status === 'duplicate' ? t('toast.duplicate') : t('toast.saved');
      persisted = result.persisted.then(async (durable) => {
        if (durable && typeof ShareIntentModule?.acknowledgeShareIntent === 'function') {
          try {
            await ShareIntentModule.acknowledgeShareIntent(share.attemptId);
          } catch {
            // Keep the native attempt replayable if acknowledgement fails.
            // URL captures dedupe by canonical URL; text and image captures
            // reuse the attempt UUID as client_id so replay is idempotent too.
          }
        }
        return durable;
      });
    } else {
      if (result.status === 'invalid' && result.reason === 'too_long') {
        // Distinguish from the generic "nothing to save" toast (Sentry
        // STASH-2J): there WAS a link, it was just too long to save.
        message = t('toast.urlTooLong');
      }
      if (typeof ShareIntentModule?.acknowledgeShareIntent === 'function') {
        // `invalid` is a terminal outcome: there is no durable work to retry.
        // Acknowledge it only after recording the diagnostic above, otherwise an
        // invalid native intent survives activity recreation and repeatedly opens
        // the app with the same toast. Failed durable writes deliberately stay
        // unacknowledged through the `saved` branch so they can be replayed.
        void ShareIntentModule.acknowledgeShareIntent(share.attemptId).catch(() => {
          // A failed acknowledgement leaves the terminal attempt available for a
          // later lifecycle retry; its recorded diagnostic explains the outcome.
        });
      }
    }
    // Bracket the save so a post-share freeze can be tied to how long the durable
    // write took. Coarse only — status/duration/durability, never content.
    trackBreadcrumb('share', 'saving', { status: result.status });
    const platform =
      Platform.OS === 'android' || Platform.OS === 'ios' || Platform.OS === 'web'
        ? Platform.OS
        : 'web';

    if (result.status === 'invalid') {
      analytics.capture(
        createCaptureCompletedEvent(
          'share',
          'invalid',
          false,
          0,
          platform,
        )
      );
    } else {
      void persisted?.then(
        (durable) => {
          recordSharePersistence(share.attemptId, durable);
          trackBreadcrumb('share', 'persisted', { ms: Date.now() - saveStartedAt, durable });
          analytics.capture(
            createCaptureCompletedEvent(
              'share',
              result.status as 'created' | 'duplicate',
              durable,
              Date.now() - saveStartedAt,
              platform,
            )
          );
        },
        () => {
          recordSharePersistence(share.attemptId, false);
          analytics.capture(
            createCaptureCompletedEvent(
              'share',
              result.status as 'created' | 'duplicate',
              false,
              Date.now() - saveStartedAt,
              platform,
            )
          );
        }
      );
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
        // Jump to the Inbox only after a brand-new capture has durably landed.
        // Duplicate refreshes are best-effort bookkeeping for an already-saved
        // row, so they must not block the duplicate toast or Inbox navigation.
        const newCaptureFailed =
          result.status === 'created' && (await persisted) === false;
        show(
          newCaptureFailed ? t('toast.saveFailed') : message,
          result.status === 'duplicate' && result.bookmark?.id
            ? {
                label: t('common.view'),
                onPress: () => router.push(`/bookmark/${result.bookmark.id}`),
              }
            : undefined,
        );
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
        if (canDismissAfterShare()) {
          if (isNewSave) {
            await recordPendingShareConfirm();
          } else if (result.status === 'duplicate' && result.bookmark?.id) {
            await recordPendingShareConfirm({ addedDuplicates: 1, bookmarkId: result.bookmark.id });
          }
        }
        await analytics.flush();
        if (await dismissAfterShare(message)) {
          return;
        }
        // Revert the confirmation if self-dismissal failed, so reopening does not show a stale toast
        if (canDismissAfterShare()) {
          await takePendingShareConfirm();
        }
      }
      show(
        message,
        result.status === 'duplicate' && result.bookmark?.id
          ? {
              label: t('common.view'),
              onPress: () => router.push(`/bookmark/${result.bookmark.id}`),
            }
          : undefined,
      );
      router.replace('/');
    })();
  }, [pendingShare, isLoading, addBookmark, router, show, t]);

  // Process lightweight native shares (Android only)
  useEffect(() => {
    if (isLoading || Platform.OS !== 'android') return;
    
    let active = true;
    async function checkOfflineShares() {
      const shares = await consumeNativePendingShares();
      if (!active || shares.length === 0) return;

      for (const share of shares) {
        const textUrlCandidate = extractFirstUrl(share.text);
        const url = textUrlCandidate;
        
        let image: SharedImage | null = null;
        if (share.file && share.mimeType?.startsWith('image/')) {
          image = {
            uri: share.file,
            mimeType: share.mimeType, fileName: 'share.jpg'
          };
        } else if (share.files && share.files.length > 0 && share.mimeType?.startsWith('image/')) {
          image = {
            uri: share.files[0],
            mimeType: share.mimeType, fileName: 'share.jpg'
          };
        }

        const result = url
          ? addBookmark({ url, title: share.title, title_is_derived: true })
          : image
            ? addBookmark({ image, title: share.title })
            : addBookmark({ shared_text: share.text, title: share.title });
            
        recordShareAttempt({
          attemptId: share.id,
          receivedAt: new Date(share.timestamp).toISOString(),
          hasUrl: url !== null,
          hasText: Boolean(share.text?.trim()),
          hasImage: image !== null,
          fileCount: share.file ? 1 : share.files ? share.files.length : 0,
          fileMimeTypes: share.mimeType ? [share.mimeType] : [],
          result: result.status,
          urlSource: textUrlCandidate ? 'text' : 'none',
          loadWaitMs: Date.now() - share.timestamp,
        });
        
        if (result.status === 'created') {
           result.persisted?.then((durable) => {
              recordSharePersistence(share.id, durable);
           });
           if (result.bookmark) {
              recordPendingShareConfirm();
           }
        }
      }
    }
    
    checkOfflineShares();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkOfflineShares();
      }
    });
    
    return () => {
      active = false;
      subscription.remove();
    };
  }, [isLoading, addBookmark]);

  return null;
}
