import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
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
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: mockReplace, back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

import AddBookmarkScreen from '@/app/add';
import { en } from '@/i18n/messages';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

async function renderAddScreen() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <AddBookmarkScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockBack.mockClear();
  mockReplace.mockClear();
  mockParams = {};
});

describe('AddBookmarkScreen duplicate UX', () => {
  it('shows "Already in Stash" when adding a URL already stashed', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    const { findByText, getByPlaceholderText, unmount } = await renderAddScreen();
    // Let the store finish loading so the in-memory dedupe sees the stored row.
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/stored');
    });
    await act(async () => {
      fireEvent.press(await findByText('Save bookmark'));
    });

    await findByText('Already in Stash');
    expect(mockBack).toHaveBeenCalled();
    // Dedupe held: no new create was enqueued.
    expect(fakeRepo.__queue()).toHaveLength(0);
    unmount();
  });

  it('renders the capture hint wired to the add.hint message key', async () => {
    fakeRepo.__reset([]);
    const { findByText, unmount } = await renderAddScreen();
    await findByText(en['add.hint'] as string);
    unmount();
  });

  it('shows "Saved to Stash" for a genuinely new URL', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    const { findByText, getByPlaceholderText, unmount } = await renderAddScreen();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/fresh');
    });
    await act(async () => {
      fireEvent.press(await findByText('Save bookmark'));
    });

    await findByText('Saved to Stash');
    expect(mockBack).toHaveBeenCalled();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    unmount();
  });
});

describe('AddBookmarkScreen web capture endpoint', () => {
  it('auto-saves a url passed via query params and lands on the Inbox', async () => {
    // The bookmarklet / PWA share target / deep link opens /add?url=…; the
    // screen skips the manual editor and captures immediately.
    fakeRepo.__reset([]);
    mockParams = { url: 'https://example.com/from-bookmarklet', title: 'From bookmarklet' };
    const { findByText, queryByPlaceholderText, unmount } = await renderAddScreen();

    // Confirms with the shared capture toast and never shows the manual form.
    await findByText('Saved to Stash');
    expect(queryByPlaceholderText('https://')).toBeNull();
    // Landed the freshly stashed item by replacing to the Inbox.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    unmount();
  });

  it('saves a no-link share as a text note via the text param', async () => {
    fakeRepo.__reset([]);
    mockParams = { text: 'a shared message with no link' };
    const { findByText, unmount } = await renderAddScreen();

    await findByText('Saved to Stash');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    unmount();
  });
});
