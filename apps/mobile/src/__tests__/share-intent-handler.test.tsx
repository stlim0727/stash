import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
// Repository fake with a controllable load gate: when `mockLoadGate.hold` is
// set, the startup `listBookmarks` blocks until `mockLoadGate.release` is
// called, letting a test hold the store in its loading state.
const mockLoadGate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
jest.mock('@/storage/repository', () => {
  const { createFakeRepositoryModule } = require('./helpers/fake-repository');
  const mod = createFakeRepositoryModule();
  const realList = mod.repository.listBookmarks.bind(mod.repository);
  mod.repository.listBookmarks = async () => {
    if (mockLoadGate.hold) {
      await new Promise<void>((resolve) => {
        mockLoadGate.release = resolve;
      });
    }
    return realList();
  };
  return mod;
});
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
// Copying the shared image into durable app storage is native-only; stub it so
// the capture path can be exercised without expo-file-system, returning a
// deterministic durable URI the test can assert on.
const mockCopyImage = jest.fn(
  async (_sourceUri: string, fileName: string) => `file:///docs/stash-images/${fileName}`,
);
// This suite runs with no auth session (see the auth-provider mock below), so
// sync never actually fires and uploadImageFile is never called for real —
// mocked anyway so the module shape stays honest if a future test changes that.
const mockUploadImageFile = jest.fn(
  async (_localUri: string, _uploadUrl: string, _headers: Record<string, string>) => undefined,
);
jest.mock('@/storage/image-store', () => ({
  copyImageToLibrary: (sourceUri: string, fileName: string) => mockCopyImage(sourceUri, fileName),
  uploadImageFile: (localUri: string, uploadUrl: string, headers: Record<string, string>) =>
    mockUploadImageFile(localUri, uploadUrl, headers),
}));
const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

// dismissAfterShare backgrounds the app on platforms that allow it. The handler
// branch only cares about its boolean result, so stub it here and drive the
// "could self-dismiss" vs "couldn't" cases per test (real native dismissal is
// covered by on-device verification).
const mockDismiss = jest.fn<boolean, [string]>();
// `canDismissAfterShare` gates the "confirm on next open" record so it's only
// written on the Android self-dismiss path. It shares Android-ness with
// `dismissAfterShare`, so the tests drive the two together per platform.
const mockCanDismiss = jest.fn<boolean, []>();
jest.mock('@/share/dismiss', () => ({
  dismissAfterShare: (message: string) => Promise.resolve(mockDismiss(message)),
  canDismissAfterShare: () => mockCanDismiss(),
}));

const mockRecordLog = jest.fn();
jest.mock('@/observability/log-buffer', () => {
  const actual = jest.requireActual('@/observability/log-buffer');
  return {
    ...actual,
    recordLog: (...args: unknown[]) => mockRecordLog(...args),
  };
});

const mockCapture = jest.fn();
const mockFlush = jest.fn(async () => {});
jest.mock('@/analytics/provider', () => ({
  useAnalytics: () => ({
    enabled: true,
    ready: true,
    capture: mockCapture,
    flush: mockFlush,
  }),
}));

// Controllable share-intent context: a cold-start share has hasShareIntent
// true from the very first render, before the durable store has loaded.
let mockShareIntent: {
  hasShareIntent: boolean;
  shareIntent: {
    webUrl: string | null;
    text: string | null;
    meta?: { title?: string; attemptId?: string };
    files?: Array<{ path: string; mimeType: string; fileName: string }> | null;
  };
  resetShareIntent: jest.Mock;
  error?: string | null;
};
// Captures the 'onDebugLog' listener the handler registers, so a test can
// invoke it directly to simulate the native module emitting the event.
let onDebugLogListener: ((event: { value: string }) => void) | null = null;
const mockRemoveDebugLogListener = jest.fn();
const mockShareIntentModule = {
  addListener: jest.fn((eventName: string, listener: (event: { value: string }) => void) => {
    if (eventName === 'onDebugLog') {
      onDebugLogListener = listener;
    }
    return { remove: mockRemoveDebugLogListener };
  }),
};
jest.mock('expo-share-intent', () => ({
  useShareIntentContext: () => mockShareIntent,
  // A getter (not a direct property) so it's evaluated lazily at access time,
  // not when this factory runs — the factory executes as soon as something
  // requires 'expo-share-intent' (hoisted above `const mockShareIntentModule`
  // in source order), so a direct reference here would capture it before it's
  // initialized.
  get ShareIntentModule() {
    return mockShareIntentModule;
  },
}));

import { SHARE_BEHAVIOR_PREF_KEY } from '@/domain/share-behavior';
import { parsePendingShareConfirm, SHARE_CONFIRM_PREF_KEY } from '@/domain/share-confirm';
import { parseShareAttemptDiagnostics, SHARE_DIAGNOSTICS_PREF_KEY } from '@/domain/share-diagnostics';
import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

const handlerTree = (
  <BookmarksProvider>
    <CaptureToastProvider>
      <ShareIntentHandler />
    </CaptureToastProvider>
  </BookmarksProvider>
);

function renderHandler() {
  return render(handlerTree);
}

beforeEach(async () => {
  mockLoadGate.hold = false;
  mockLoadGate.release = null;
  mockRouter.push.mockClear();
  mockRouter.navigate.mockClear();
  mockRouter.replace.mockClear();
  mockRouter.back.mockClear();
  // Default: the OS won't let us self-dismiss, so toast mode lands on the Inbox
  // and the in-app toast is shown (which the existing assertions rely on).
  mockDismiss.mockReset();
  mockDismiss.mockReturnValue(false);
  // Default to "can't self-dismiss" (iOS/web), matching the default dismiss
  // result; Android tests opt both into true.
  mockCanDismiss.mockReset();
  mockCanDismiss.mockReturnValue(false);
  mockCopyImage.mockClear();
  mockRecordLog.mockClear();
  onDebugLogListener = null;
  mockShareIntentModule.addListener.mockClear();
  mockRemoveDebugLogListener.mockClear();
  // Reset the persisted share-behavior preference to the default between tests
  // (the fake repo's meta store outlives a single test).
  await fakeRepo.repository.setMeta(SHARE_BEHAVIOR_PREF_KEY, 'toast');
  // Clear any pending "confirm on next open" record the meta store carried over.
  await fakeRepo.repository.setMeta(SHARE_CONFIRM_PREF_KEY, JSON.stringify({ savedCount: 0 }));
  mockShareIntent = {
    hasShareIntent: false,
    shareIntent: { webUrl: null, text: null },
    resetShareIntent: jest.fn(),
    error: null,
  };
});

describe('ShareIntentHandler', () => {
  // These cover the cold-start / slow-load capture paths with real timers and a
  // gated repository load. Each is <300ms locally, but on the constrained CI
  // runner — where heavier suites (e.g. the tag-cloud inbox screen) run
  // concurrently — the default 5s jest timeout can be starved. Give the
  // async-heavy suite more headroom so contention can't flake it.
  jest.setTimeout(15000);

  it('does not duplicate a URL already stashed when shared on cold start', async () => {
    // The store starts empty in memory and loads this row asynchronously —
    // exactly the cold-start window in which a share used to dedupe against an
    // empty set and create a duplicate.
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/stored', text: null },
      resetShareIntent: jest.fn(),
      error: null,
    };

    const { findByText, unmount } = await renderHandler();

    // It waits for the store to load, finds the existing bookmark, and reports a
    // duplicate instead of enqueuing a new create.
    await findByText('Already in Keepory');
    await waitFor(() => expect(mockShareIntent.resetShareIntent).toHaveBeenCalled());
    expect(fakeRepo.__queue()).toHaveLength(0);
    unmount();
  });

  it('inbox mode opens the Inbox without waiting for a duplicate refresh write', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    await fakeRepo.repository.setMeta(SHARE_BEHAVIOR_PREF_KEY, 'inbox');
    const originalUpdate = fakeRepo.repository.updateBookmark;
    fakeRepo.repository.updateBookmark = jest.fn(() => {
      return new Promise(() => {});
    });
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/stored', text: null },
      resetShareIntent: jest.fn(),
    };

    try {
      const { findByText, unmount } = await renderHandler();

      await findByText('Already in Keepory');
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
      expect(fakeRepo.repository.updateBookmark).toHaveBeenCalledTimes(1);
      expect(fakeRepo.__queue()).toHaveLength(0);
      unmount();
    } finally {
      fakeRepo.repository.updateBookmark = originalUpdate;
    }
  });

  it('saves and enqueues a genuinely new shared URL', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/fresh', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe('https://example.com/fresh');
    unmount();
  });

  it('still saves the share if the OS intent is reset during a slow store load', async () => {
    // resetOnBackground (or the user backing out) can clear the expo-share-intent
    // context before a slow SQLite load finishes. The capture must survive that:
    // the URL is copied into local state and the intent released up front, then
    // saved once the store loads.
    fakeRepo.__reset([]);
    mockLoadGate.hold = true;
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/slow', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, rerender, unmount } = await renderHandler();

    // The intent was copied out and released immediately, before the store loaded.
    await waitFor(() => expect(mockShareIntent.resetShareIntent).toHaveBeenCalled());
    expect(fakeRepo.__queue()).toHaveLength(0);

    // Simulate resetOnBackground clearing the OS intent mid-load.
    mockShareIntent = {
      hasShareIntent: false,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
    };
    await act(async () => {
      rerender(handlerTree);
    });

    // The store finishes loading — the held capture is now saved.
    await act(async () => {
      mockLoadGate.release?.();
    });

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe('https://example.com/slow');
    unmount();
  });

  it('records how long a share waited on a slow cold-start load (Sentry STASH-2T/STASH-2V)', async () => {
    // Distinguishes "the share arrived but sat waiting on a slow cold start"
    // from "the share never reached this code at all" — the two very
    // different failure modes both prior reports' "shared but nothing saved,
    // no toast" could describe, with no evidence to tell them apart.
    fakeRepo.__reset([]);
    mockLoadGate.hold = true;
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/cold', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();
    await waitFor(() => expect(mockShareIntent.resetShareIntent).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 60));
    await act(async () => {
      mockLoadGate.release?.();
    });

    await findByText('Saved to Keepory');
    await waitFor(async () => {
      const record = parseShareAttemptDiagnostics(
        await fakeRepo.repository.getMeta(SHARE_DIAGNOSTICS_PREF_KEY),
      );
      expect(typeof record?.loadWaitMs).toBe('number');
      expect(record?.loadWaitMs).toBeGreaterThanOrEqual(40);
    });
    unmount();
  });

  it('re-sharing a share.google link with a different si token dedupes to one bookmark', async () => {
    // issie's exact report: re-sharing the same content (share.google / YouTube)
    // appends a fresh ?si=… share token each time, so the two payloads differ.
    // Canonicalization strips si for these hosts, so the second share must
    // dedupe end-to-end through the handler rather than pile up a duplicate.
    // A fresh element per render mirrors a real second share, which re-renders
    // the handler with a new share-intent context (passing the same element
    // reference would let React bail out of re-rendering and never re-read it).
    const freshTree = () => (
      <BookmarksProvider>
        <CaptureToastProvider>
          <ShareIntentHandler />
        </CaptureToastProvider>
      </BookmarksProvider>
    );
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://share.google/bb3vpuiCbbyVhrpTp?si=Kgq04hU28tQmyOaV', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, rerender, unmount } = await render(freshTree());

    // First share saves and enqueues exactly one create.
    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));

    // The OS clears the intent after handling; re-fire it with the same link but
    // a DIFFERENT si token, as a real second share would.
    mockShareIntent = {
      hasShareIntent: false,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
    };
    await act(async () => {
      rerender(freshTree());
    });
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://share.google/bb3vpuiCbbyVhrpTp?si=g2oSW1QiR4zjMhzS', text: null },
      resetShareIntent: jest.fn(),
    };
    await act(async () => {
      rerender(freshTree());
    });

    // Second share reuses the existing bookmark: duplicate toast, no new create,
    // and still exactly one bookmark in the store.
    await findByText('Already in Keepory');
    expect(fakeRepo.__queue()).toHaveLength(1);
    expect(await fakeRepo.repository.listBookmarks()).toHaveLength(1);
    unmount();
  });

  it('toast mode lands on the Inbox when the app cannot self-dismiss', async () => {
    // iOS/web can't background the app, so a toast-mode share must not strand
    // the user on whatever stale screen the app resumed onto — it lands on the
    // Inbox and shows the in-app toast instead.
    fakeRepo.__reset([]);
    mockDismiss.mockReturnValue(false);
    mockCanDismiss.mockReturnValue(false);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/toast', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(mockDismiss).toHaveBeenCalledWith('Saved to Keepory');
    // The in-app toast + Inbox already confirmed the save in this session, so no
    // "confirm on next open" record is left behind to re-confirm on next launch.
    expect(parsePendingShareConfirm(await fakeRepo.repository.getMeta(SHARE_CONFIRM_PREF_KEY))).toBeNull();
    unmount();
  });

  it('toast mode dismisses the app (no navigation) when the OS allows it', async () => {
    // Android can self-dismiss: after the capture is durably written we hand
    // control back to the previous app — no in-app navigation, and crucially
    // the save is already enqueued before we leave (capture is sacred).
    fakeRepo.__reset([]);
    mockDismiss.mockReturnValue(true);
    mockCanDismiss.mockReturnValue(true);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/bg', text: null },
      resetShareIntent: jest.fn(),
    };

    const { unmount } = await renderHandler();

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith('Saved to Keepory'));
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    // The system toast is gone by the time the app reopens, so a record is left
    // for the next foreground to confirm this brand-new save.
    await waitFor(() =>
      expect(fakeRepo.repository.getMeta(SHARE_CONFIRM_PREF_KEY)).resolves.toBe(
        JSON.stringify({ savedCount: 1 }),
      ),
    );
    unmount();
  });

  it('toast mode does not dismiss the app when the durable write fails', async () => {
    // If the only copy of a freshly shared bookmark is still in optimistic
    // in-memory state because the SQLite write failed, backgrounding the app
    // would lose it. The handler must keep the user in-app (Inbox) instead —
    // even though the OS *could* self-dismiss. Capture is sacred.
    fakeRepo.__reset([]);
    mockDismiss.mockReturnValue(true);
    const originalInsert = fakeRepo.repository.insertBookmark;
    fakeRepo.repository.insertBookmark = jest.fn(async () => {
      throw new Error('simulated storage failure');
    });
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/fail', text: null },
      resetShareIntent: jest.fn(),
    };

    try {
      const { findByText, unmount } = await renderHandler();

      await findByText('Saved to Keepory');
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
      expect(mockDismiss).not.toHaveBeenCalled();
      unmount();
    } finally {
      fakeRepo.repository.insertBookmark = originalInsert;
    }
  });

  it('recovers a webUrl carrying interior whitespace instead of silently dropping it', async () => {
    // A source app (e.g. welaaa) can hand over a `webUrl` that `normalizeUrl`
    // rejects — here a link with a title appended after a space. The handler used
    // to pass it straight to addBookmark, which returned `invalid`, so the share
    // was lost and (in toast mode) the app dismissed back to the source app.
    // Routing webUrl through extractFirstUrl recovers the real link and saves it.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: 'https://www.welaaa.com/ebook/detail/180284?appRedirect=true 윌라',
        text: null,
      },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe(
      'https://www.welaaa.com/ebook/detail/180284?appRedirect=true',
    );
    unmount();
  });

  it('falls back to the shared text when webUrl is a non-http scheme', async () => {
    // A custom-scheme webUrl (e.g. an in-app deep link) is not a saveable web
    // URL, but the share still carries a usable link in its text. The handler
    // must extract that rather than treating the deep link as the URL and
    // dropping the capture.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: 'welaaa://ebook/180284',
        text: 'https://www.welaaa.com/ebook/detail/180284',
      },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe('https://www.welaaa.com/ebook/detail/180284');
    unmount();
  });

  it('does not dismiss the app for a genuinely empty share even when the OS allows it', async () => {
    // With nothing to save, backgrounding back to the source app would read as a
    // silent failure. The handler lands on the Inbox and shows the "no link"
    // toast instead of dismissing.
    fakeRepo.__reset([]);
    mockDismiss.mockReturnValue(true);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: null, text: '   ' },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('No link found to save');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(mockDismiss).not.toHaveBeenCalled();
    unmount();
  });

  it('saves a no-link shared text (e.g. a KakaoTalk message) as a text note', async () => {
    // KakaoTalk and similar apps often share plain text with no URL. Rather than
    // dropping it with a "no link" toast, the handler saves it as a text note so
    // deliberately shared content is never lost. Capture is sacred.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: null, text: '내일 3시에 회의 있습니다' },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    const entry = fakeRepo.__queue()[0];
    expect(entry.payload.url).toBeUndefined();
    expect(entry.payload.shared_text).toBe('내일 3시에 회의 있습니다');
    const stored = await fakeRepo.repository.listBookmarks();
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBeNull();
    expect(stored[0].content_type).toBe('text');
    expect(stored[0].description).toBe('내일 3시에 회의 있습니다');
    unmount();
  });

  it('shows "no link" and saves nothing for a genuinely empty share', async () => {
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: null, text: '   ' },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('No link found to save');
    await waitFor(() => expect(mockShareIntent.resetShareIntent).toHaveBeenCalled());
    expect(fakeRepo.__queue()).toHaveLength(0);
    expect(await fakeRepo.repository.listBookmarks()).toHaveLength(0);
    // Regression coverage for Sentry STASH-27/STASH-2A: this exact "nothing
    // extracted" shape is what those reports almost certainly hit, but the
    // in-memory log buffer reset before the user filed feedback, so nothing
    // proved it. The durable record now survives that restart.
    const record = parseShareAttemptDiagnostics(
      await fakeRepo.repository.getMeta(SHARE_DIAGNOSTICS_PREF_KEY),
    );
    expect(record).toMatchObject({ hasUrl: false, hasText: false, hasImage: false, result: 'invalid' });
    unmount();
  });

  it('durably records a successful URL share for the next diagnostics report', async () => {
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: 'https://example.com/durable',
        text: null,
        meta: { attemptId: 'native-attempt-1' },
      },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(async () => {
      const record = parseShareAttemptDiagnostics(
        await fakeRepo.repository.getMeta(SHARE_DIAGNOSTICS_PREF_KEY),
      );
      expect(record).toMatchObject({
        attemptId: 'native-attempt-1',
        hasUrl: true,
        hasText: false,
        hasImage: false,
        result: 'created',
        durable: true,
      });
      expect(record?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record?.persistedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
    unmount();
  });

  it('surfaces and logs a native share-intent error when no payload is available', async () => {
    // Some Android senders can match our share target but still fail inside the
    // native parser before JS receives text/files. The user must see a failure
    // instead of a silent Inbox open, and monitoring needs a coarse native error
    // without any shared content.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: false,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
      error: 'empty uri for file sharing: android.intent.action.SEND',
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('No link found to save');
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(mockShareIntent.resetShareIntent).toHaveBeenCalled();
    expect(fakeRepo.__queue()).toHaveLength(0);
    expect(await fakeRepo.repository.listBookmarks()).toHaveLength(0);
    expect(mockRecordLog).toHaveBeenCalledWith(
      'error',
      '[share] native share intent error',
      [expect.any(Error)],
    );
    const loggedError = mockRecordLog.mock.calls.find(
      ([level, message]) => level === 'error' && message === '[share] native share intent error',
    )?.[2]?.[0];
    expect(loggedError.message).toBe('empty uri for file sharing: android.intent.action.SEND');
    unmount();
  });

  it('logs a native onDebugLog event without triggering the error/reset/navigate flow (Sentry STASH-2K)', async () => {
    // The instrumentation added for STASH-2K's investigation must stay purely
    // observational — reusing the `onError` channel for it (an earlier
    // attempt, caught in PR review) would have shown a false "no link found"
    // toast and reset the share on every ordinary non-task-root relaunch.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: false,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
      error: null,
    };

    const { unmount } = await renderHandler();

    await waitFor(() => expect(onDebugLogListener).not.toBeNull());
    await act(async () => {
      onDebugLogListener?.({ value: 'relaunching non-task-root activity for action: android.intent.action.SEND' });
    });

    expect(mockRecordLog).toHaveBeenCalledWith(
      'info',
      '[share] native debug: relaunching non-task-root activity for action: android.intent.action.SEND',
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockShareIntent.resetShareIntent).not.toHaveBeenCalled();
    expect(fakeRepo.__queue()).toHaveLength(0);
    // Let the store's own async startup load (BookmarksProvider) settle before
    // tearing down — unmounting mid-load left a stray promise that resolved
    // into the NEXT test's freshly-reset fake repository, breaking it.
    await waitFor(() => expect(fakeRepo.__listBookmarksCalls()).toBeGreaterThan(0));
    unmount();
  });

  it('captures a shared image as a bookmark, queued for a real background upload', async () => {
    // Sharing a screenshot/photo arrives as shareIntent.files (no webUrl). The
    // handler copies it into durable storage, saves an image bookmark, and
    // queues a real create — capture itself stays local-first/optimistic and
    // renders immediately regardless of the (mocked-out, session-less in this
    // test) network sync that follows.
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: null,
        text: null,
        files: [{ path: 'file:///tmp/share/IMG_042.png', mimeType: 'image/png', fileName: 'IMG_0042.png' }],
      },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    // The temp file was copied into the document directory under <id>.png.
    await waitFor(() => expect(mockCopyImage).toHaveBeenCalledTimes(1));
    const [sourceUri, fileName] = mockCopyImage.mock.calls[0];
    expect(sourceUri).toBe('file:///tmp/share/IMG_042.png');
    expect(fileName).toMatch(/\.png$/);

    const stored = await fakeRepo.repository.listBookmarks();
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBeNull();
    expect(stored[0].content_type).toBe('image');
    expect(stored[0].metadata_status).toBe('skipped');
    expect(stored[0].local_image_uri).toBe(`file:///docs/stash-images/${fileName}`);
    // Title derived from the shared filename.
    expect(stored[0].title).toBe('IMG 0042');
    // The real MIME type from the share sheet is recorded at capture time —
    // the upload step uses this directly, never guessing from the local
    // file's extension (which can mislabel an uncommon format's
    // Content-Type; see mimeTypeForImageUri's doc comment).
    expect(stored[0].local_image_mime_type).toBe('image/png');
    // Queued like any other create — honest 'pending' state (no fake
    // "already synced" bookkeeping), same shape as a text note capture.
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].operation).toBe('create');
    expect(fakeRepo.__queue()[0].payload.content_type).toBe('image');
    expect(stored[0].sync_status).toBe('pending');
    unmount();
  });

  it('durably inserts the image bookmark row BEFORE enqueueing its create (not concurrently)', async () => {
    // A crash between the two durable writes must always land on the side
    // reconcileOrphanedQueueEntries already self-heals (a bookmark row with
    // no queue entry yet) — never a queue entry with no matching bookmark
    // row (which retries a create forever: there is no local row left to
    // read local_image_uri/preview_image_url from). Proven with a genuine
    // race, not just an after-the-fact call-order comparison: insertBookmark
    // is made artificially slow, and enqueue is made to THROW if it fires
    // before insertBookmark's promise has actually resolved. A naive
    // `Promise.all([insertBookmark(...), enqueue(...)])` would let the
    // (synchronous, real fast) enqueue fire immediately, well before the
    // delayed insert resolves — this test only passes for genuinely
    // sequential `insertBookmark().then(() => enqueue())` code.
    fakeRepo.__reset([]);
    const originalInsertBookmark = fakeRepo.repository.insertBookmark;
    const originalEnqueue = fakeRepo.repository.enqueue;
    let insertResolved = false;
    fakeRepo.repository.insertBookmark = async (bookmark) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await originalInsertBookmark(bookmark);
      insertResolved = true;
    };
    fakeRepo.repository.enqueue = async (entry) => {
      if (!insertResolved) {
        throw new Error('enqueue fired before insertBookmark resolved');
      }
      await originalEnqueue(entry);
    };

    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: null,
        text: null,
        files: [{ path: 'file:///tmp/share/race.png', mimeType: 'image/png', fileName: 'race.png' }],
      },
      resetShareIntent: jest.fn(),
    };

    try {
      const { findByText, unmount } = await renderHandler();
      await findByText('Saved to Keepory');
      // addBookmark's own `persisted` chain catches a thrown enqueue and
      // just logs it (capture must never crash the app) — so an early
      // enqueue doesn't fail this test via an exception. It fails via THIS
      // `waitFor` instead: if enqueue fired early, the injected throw means
      // `originalEnqueue` never actually ran, the queue never reaches length
      // 1, and this times out.
      await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
      expect(insertResolved).toBe(true);
      unmount();
    } finally {
      fakeRepo.repository.insertBookmark = originalInsertBookmark;
      fakeRepo.repository.enqueue = originalEnqueue;
    }
  });

  it('inbox mode jumps to the Inbox and never dismisses the app', async () => {
    fakeRepo.__reset([]);
    await fakeRepo.repository.setMeta(SHARE_BEHAVIOR_PREF_KEY, 'inbox');
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/inbox', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(mockDismiss).not.toHaveBeenCalled();
    unmount();
  });

  it('inbox mode does not navigate as a successful save when the durable write fails', async () => {
    fakeRepo.__reset([]);
    await fakeRepo.repository.setMeta(SHARE_BEHAVIOR_PREF_KEY, 'inbox');
    const originalInsert = fakeRepo.repository.insertBookmark;
    fakeRepo.repository.insertBookmark = jest.fn(async () => {
      throw new Error('simulated storage failure');
    });
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/inbox-fail', text: null },
      resetShareIntent: jest.fn(),
    };

    try {
      const { findByText, unmount } = await renderHandler();

      await findByText('Could not save to Keepory');
      expect(mockRouter.replace).not.toHaveBeenCalled();
      expect(mockDismiss).not.toHaveBeenCalled();
      unmount();
    } finally {
      fakeRepo.repository.insertBookmark = originalInsert;
    }
  });

  it('toast mode reverts the pending confirm and lands on Inbox if self-dismissal fails', async () => {
    // Android can self-dismiss, but if the dismissal fails, it should revert the
    // written pending confirmation record, show the in-app toast, and navigate to the Inbox.
    fakeRepo.__reset([]);
    mockDismiss.mockReturnValue(false);
    mockCanDismiss.mockReturnValue(true);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/dismiss-fail', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith('Saved to Keepory'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));

    // The confirmation record must be reverted since dismissal failed and the user remains in-app
    const confirm = parsePendingShareConfirm(await fakeRepo.repository.getMeta(SHARE_CONFIRM_PREF_KEY));
    expect(confirm).toBeNull();
    unmount();
  });

  it('triggers capture_completed PostHog event on successful save', async () => {
    mockCapture.mockClear();
    mockFlush.mockClear();
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/ph-success', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Keepory');

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'capture_completed',
          properties: expect.objectContaining({
            source: 'share',
            result: 'created',
            durable: true,
          }),
        })
      );
    });
    expect(mockFlush).toHaveBeenCalled();
    unmount();
  });

  it('triggers capture_completed PostHog event on duplicate save', async () => {
    mockCapture.mockClear();
    mockFlush.mockClear();
    const existingBookmark = makeStoredBookmark({
      id: 'existing-id',
      url: 'https://example.com/ph-duplicate',
    });
    fakeRepo.__reset([existingBookmark]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/ph-duplicate', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Already in Keepory');

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'capture_completed',
          properties: expect.objectContaining({
            source: 'share',
            result: 'duplicate',
            durable: true,
          }),
        })
      );
    });
    expect(mockFlush).toHaveBeenCalled();
    unmount();
  });

  it('triggers capture_completed PostHog event on invalid save', async () => {
    mockCapture.mockClear();
    mockFlush.mockClear();
    fakeRepo.__reset([]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
    };

    const { unmount } = await renderHandler();

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'capture_completed',
          properties: expect.objectContaining({
            source: 'share',
            result: 'invalid',
            durable: false,
            persistence_ms: 0,
          }),
        })
      );
    });
    expect(mockFlush).not.toHaveBeenCalled();
    unmount();
  });
});
