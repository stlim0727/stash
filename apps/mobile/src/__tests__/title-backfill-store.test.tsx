import { render, waitFor } from '@testing-library/react-native';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Signed out: no session is ever minted, so sync/pull never runs and the
// backfill is exercised purely against the local durable rows.
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: null,
    userId: null,
    message: null,
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: unknown }) => children,
}));

// Inert network layer — the store must not reach it while signed out, but any
// stray list call resolves empty rather than throwing.
jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  return {
    createBookmark: empty,
    listBookmarks: empty,
    listBookmarkIds: empty,
    listEnrichmentsUpdatedSince: empty,
    listTags: empty,
    listBookmarkTags: empty,
    listCollections: empty,
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

type Store = ReturnType<typeof useBookmarks>;

function renderStore() {
  const ref: { current: Store | null } = { current: null };
  function Probe() {
    ref.current = useBookmarks();
    return null;
  }
  render(
    <BookmarksProvider>
      <Probe />
    </BookmarksProvider>,
  );
  return ref;
}

const THREADS_ID = '7e64cf1e-0000-4000-8000-0000000000b1';
const RENAMED_ID = '7e64cf1e-0000-4000-8000-0000000000b2';
const YOUTUBE_ID = '7e64cf1e-0000-4000-8000-0000000000b3';

test('the title backfill repairs a machine-fallback title but not a user rename', async () => {
  fakeRepo.__reset([
    // A structurally-unfetchable row still labelled with the post-id slug it
    // fell back to — exactly what the backfill should repair.
    makeStoredBookmark({
      id: THREADS_ID,
      url: 'https://www.threads.com/@ephemeris.ai/post/Dabls52E90n',
      title: 'Dabls52E90n',
      metadata_status: 'complete',
    }),
    // A user-renamed row whose title is NOT the historical fallback — must be
    // left exactly as-is (capture is sacred).
    makeStoredBookmark({
      id: RENAMED_ID,
      url: 'https://youtu.be/MEvcN4Nwa1g',
      title: 'My swim clip',
      metadata_status: 'complete',
    }),
  ]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The Threads slug is upgraded to a human, author-led label…
  await waitFor(() =>
    expect(store.current?.getBookmark(THREADS_ID)?.title).toBe('Threads post by @ephemeris.ai'),
  );
  // …and the repair is durable, not just in-memory.
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === THREADS_ID)?.title).toBe(
      'Threads post by @ephemeris.ai',
    ),
  );

  // The user's title is untouched, in memory and in storage.
  expect(store.current?.getBookmark(RENAMED_ID)?.title).toBe('My swim clip');
  expect(fakeRepo.__bookmarks().find((b) => b.id === RENAMED_ID)?.title).toBe('My swim clip');
});

test('the title backfill batches durable reads for multiple repair targets', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: THREADS_ID,
      url: 'https://www.threads.com/@ephemeris.ai/post/Dabls52E90n',
      title: 'Dabls52E90n',
      metadata_status: 'complete',
    }),
    makeStoredBookmark({
      id: YOUTUBE_ID,
      url: 'https://youtu.be/MEvcN4Nwa1g',
      title: 'youtu.be',
      metadata_status: 'complete',
    }),
  ]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === THREADS_ID)?.title).toBe(
      'Threads post by @ephemeris.ai',
    ),
  );
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === YOUTUBE_ID)?.title).toBe(
      'YouTube video',
    ),
  );

  // Initial load + one batched durable backfill read, not one full read per
  // repair target; each target is then re-read by id immediately before its
  // full-row storage write.
  expect(fakeRepo.__listBookmarksCalls()).toBeLessThanOrEqual(2);
  expect(fakeRepo.__getBookmarkCalls()).toBe(2);
});
