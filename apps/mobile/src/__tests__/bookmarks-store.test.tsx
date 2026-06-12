import { act, renderHook, waitFor } from '@testing-library/react-native';
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

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  return utils;
}

beforeEach(() => {
  fakeRepo.__reset();
});

test('addBookmark shows the bookmark immediately and queues a create', async () => {
  const { result } = await renderStore();

  let outcome = '';
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'example.com/article' }).status;
  });

  expect(outcome).toBe('created');
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  expect(result.current.inbox[0]?.url).toBe('https://example.com/article');
  expect(result.current.inbox[0]?.sync_status).toBe('pending');
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  expect(fakeRepo.__queue()[0]?.operation).toBe('create');
});

test('saving the same URL twice reuses the existing bookmark', async () => {
  const { result } = await renderStore();

  await act(async () => {
    result.current.addBookmark({ url: 'example.com/a' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({ url: 'https://example.com/a' }).status;
  });

  expect(status).toBe('duplicate');
  expect(result.current.inbox).toHaveLength(1);
});

test('invalid input is rejected with a message and saves nothing', async () => {
  const { result } = await renderStore();

  let outcome: ReturnType<typeof result.current.addBookmark> | null = null;
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'not a url' });
  });

  expect(outcome).toMatchObject({ status: 'invalid' });
  expect(result.current.inbox).toHaveLength(0);
});

test('archiving moves a bookmark from inbox to archived and back', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/b' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.archiveBookmark(id, true);
  });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.archived).toHaveLength(1);

  await act(async () => {
    result.current.archiveBookmark(id, false);
  });
  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.archived).toHaveLength(0);
});

test('deleting a local bookmark also clears its queued upload', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/c' });
  });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.deleteBookmark(id);
  });

  expect(result.current.inbox).toHaveLength(0);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
});

test('updateBookmarkFields edits the title and clears it back to null', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/d', title: 'Original' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: 'Renamed', notes: 'a note' });
  });
  expect(result.current.inbox[0]).toMatchObject({ title: 'Renamed', notes: 'a note' });

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: '' });
  });
  expect(result.current.inbox[0]?.title).toBeNull();
});

test('bookmarks stored from a previous session load on startup', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([makeStoredBookmark({ title: 'From last session' })]);

  const { result } = await renderStore();

  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.inbox[0]?.title).toBe('From last session');
});
