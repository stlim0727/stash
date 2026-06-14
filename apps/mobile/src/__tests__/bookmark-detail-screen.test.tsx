import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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

const mockNavigate = jest.fn();
// The detail screen reads the bookmark id from the route; tests set it.
let mockRouteId = 'bookmark-raindrop';
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: mockRouteId }),
}));

import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderDetail() {
  return render(
    <BookmarksProvider>
      <BookmarkDetailScreen />
    </BookmarksProvider>,
  );
}

test('tapping a tag chip navigates to the Inbox filtered by that tag', async () => {
  mockRouteId = 'bookmark-raindrop';
  // The seeded sample "bookmark-raindrop" carries the mock tag "design".
  fakeRepo.__reset([makeStoredBookmark({ id: 'bookmark-raindrop', title: 'Raindrop review' })]);

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Browse #design'));

  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', params: { tag: 'tag-design' } });
});

test('renders AI suggestions with a model badge, summary, and trigger button', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
        model: 'dummy-v0',
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText('dummy-v0')).toBeTruthy();
  expect(screen.getByText('A url from example.com.')).toBeTruthy();
  expect(screen.getByLabelText('Accept suggested tag design')).toBeTruthy();
  expect(screen.getByLabelText('Accept suggested tag video')).toBeTruthy();
  // Synced bookmark → the on-demand trigger is offered.
  expect(screen.getByText('Refresh AI suggestions')).toBeTruthy();
});

test('a stale enrichment shows an out-of-date hint', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        status: 'stale',
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText(/may be out of date since you edited this bookmark/)).toBeTruthy();
});

test('dismissing a suggested tag removes it from the list', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Accept suggested tag design')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss suggested tag design'));

  expect(screen.queryByLabelText('Accept suggested tag design')).toBeNull();
  expect(screen.getByLabelText('Accept suggested tag video')).toBeTruthy();
});
