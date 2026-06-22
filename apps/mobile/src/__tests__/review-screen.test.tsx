import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// `mock`-prefixed so jest's hoisted factory may close over it.
const mockRouterPush = jest.fn();

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
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: mockRouterPush, navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

import ReviewScreen from '@/app/review';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderReview() {
  return render(
    <BookmarksProvider>
      <ReviewScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockRouterPush.mockClear();
});

test('lists bookmarks with pending high-confidence suggestions and their chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000a1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'A bookmark to review' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.7 },
          // Below the 0.6 threshold — must not appear.
          { name: 'noise', confidence: 0.3 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('A bookmark to review')).toBeTruthy());
  expect(screen.getByText('＋ design')).toBeTruthy();
  expect(screen.getByText('＋ video')).toBeTruthy();
  expect(screen.queryByText('＋ noise')).toBeNull();
  // Two suggestions -> an "Accept all" affordance.
  expect(screen.getByText('Accept all')).toBeTruthy();
});

test('shows the empty state when nothing is pending', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Plain bookmark' })]);

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('No suggestions to review.')).toBeTruthy());
});

test('tapping the card title navigates to the bookmark detail', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Open me' })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.9 }] })],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Open me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Go to Open me'));

  expect(mockRouterPush).toHaveBeenCalledWith({ pathname: '/bookmark/[id]', params: { id } });
});

test('"Dismiss all" clears the card without applying any tags', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Dismiss me' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.8 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Dismiss me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Dismiss all suggested tags for Dismiss me'));

  // The card drops out, and dismissing applies no tags (the chips just vanish).
  await waitFor(() => expect(screen.queryByText('Dismiss me')).toBeNull());
  expect(screen.queryByText('＋ design')).toBeNull();
});

test('"Accept all" clears the card', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b3';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Accept me' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.8 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Accept me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Accept all suggested tags for Accept me'));

  await waitFor(() => expect(screen.queryByText('Accept me')).toBeNull());
});
