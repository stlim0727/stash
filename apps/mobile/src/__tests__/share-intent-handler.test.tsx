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
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
// Force the in-app-toast fallback so these assertions hold regardless of the
// jest platform: the Android "floating toast + return to previous app" path is
// covered in return-to-app.test.tsx.
jest.mock('@/share/return-to-app', () => ({
  showSystemToast: jest.fn(() => false),
  returnToPreviousApp: jest.fn(() => false),
}));

// Controllable share-intent context: a cold-start share has hasShareIntent
// true from the very first render, before the durable store has loaded.
let mockShareIntent: {
  hasShareIntent: boolean;
  shareIntent: { webUrl: string | null; text: string | null; meta?: { title?: string } };
  resetShareIntent: jest.Mock;
};
jest.mock('expo-share-intent', () => ({
  useShareIntentContext: () => mockShareIntent,
}));

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

beforeEach(() => {
  mockLoadGate.hold = false;
  mockLoadGate.release = null;
  mockShareIntent = {
    hasShareIntent: false,
    shareIntent: { webUrl: null, text: null },
    resetShareIntent: jest.fn(),
  };
});

describe('ShareIntentHandler', () => {
  it('does not duplicate a URL already stashed when shared on cold start', async () => {
    // The store starts empty in memory and loads this row asynchronously —
    // exactly the cold-start window in which a share used to dedupe against an
    // empty set and create a duplicate.
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/stored', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    // It waits for the store to load, finds the existing bookmark, and reports a
    // duplicate instead of enqueuing a new create.
    await findByText('Already in Stash');
    await waitFor(() => expect(mockShareIntent.resetShareIntent).toHaveBeenCalled());
    expect(fakeRepo.__queue()).toHaveLength(0);
    unmount();
  });

  it('saves and enqueues a genuinely new shared URL', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/fresh', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    await findByText('Saved to Stash');
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

    await findByText('Saved to Stash');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe('https://example.com/slow');
    unmount();
  });

  it('recovers a share persisted before the app was killed, on the next launch', async () => {
    // The previous launch captured a share (durably recording it) but was killed
    // while backgrounded before its deferred save could run. This launch has no
    // live share intent; the store must drain the leftover and save it.
    fakeRepo.__reset([]);
    await fakeRepo.repository.setMeta(
      'pending_shares',
      JSON.stringify([
        { url: 'https://example.com/recovered', captured_at: '2026-06-19T00:00:00.000Z' },
      ]),
    );
    mockShareIntent = {
      hasShareIntent: false,
      shareIntent: { webUrl: null, text: null },
      resetShareIntent: jest.fn(),
    };

    const { unmount } = await renderHandler();

    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__queue()[0].payload.url).toBe('https://example.com/recovered');
    // The drained entry is cleared so it isn't re-saved on a later launch.
    await waitFor(() => expect(fakeRepo.__meta('pending_shares')).toBe('[]'));
    unmount();
  });

  it('records the shared URL durably the moment it is captured', async () => {
    // Even before the deferred save runs, the raw capture is persisted so a
    // process kill can't lose it. The fake store loads instantly here, so by the
    // time the save lands the record is cleared again — assert it was written.
    fakeRepo.__reset([]);
    mockLoadGate.hold = true;
    mockShareIntent = {
      hasShareIntent: true,
      shareIntent: { webUrl: 'https://example.com/durable', text: null },
      resetShareIntent: jest.fn(),
    };

    const { findByText, unmount } = await renderHandler();

    // While the store load is held, the durable record already exists.
    await waitFor(() =>
      expect(fakeRepo.__meta('pending_shares')).toContain('https://example.com/durable'),
    );

    // Release the load: the deferred save runs and clears the record.
    await act(async () => {
      mockLoadGate.release?.();
    });
    await findByText('Saved to Stash');
    await waitFor(() => expect(fakeRepo.__meta('pending_shares')).toBe('[]'));
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
    await findByText('Saved to Stash');
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
    await findByText('Already in Stash');
    expect(fakeRepo.__queue()).toHaveLength(1);
    expect(await fakeRepo.repository.listBookmarks()).toHaveLength(1);
    unmount();
  });
});
