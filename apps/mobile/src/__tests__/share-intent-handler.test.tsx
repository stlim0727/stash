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
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

const handlerTree = (
  <BookmarksProvider>
    <ShareIntentHandler />
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
});
