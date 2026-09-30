import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
// No Supabase session: tagging must still work locally (the local-first win).
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
import { makeStoredBookmark } from './helpers/fake-repository';

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
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
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
});

test('adding a tag offline shows it immediately and queues the op', async () => {
  const { result } = await renderStore();

  let error: string | null = 'unset';
  await act(async () => {
    error = await result.current.addTagsToBookmark(SYNCED_ID, ['korean']);
  });

  // Succeeds with no session — applied locally, not blocked on the cloud.
  expect(error).toBeNull();
  expect(result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).toContain('korean');

  // The op is durably queued for a later upload.
  await waitFor(() => expect(fakeRepo.__meta('pending_tag_ops') ?? '').toContain('korean'));
});

test('removing a just-added tag retains a durable removal intent', async () => {
  const { result } = await renderStore();

  await act(async () => {
    await result.current.addTagsToBookmark(SYNCED_ID, ['korean']);
  });
  await act(async () => {
    await result.current.removeTagFromBookmark(SYNCED_ID, 'korean');
  });

  expect(result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).not.toContain('korean');
  // A removal must survive a possibly in-flight add and the next pull.
  await waitFor(() => {
    const ops = JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]');
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('remove');
  });
});


test('a never-synced bookmark can be tagged offline and survives a provider restart', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, sync_status: 'pending', ever_synced: false })]);
  const first = await renderStore();
  await act(async () => {
    expect(await first.result.current.addTagsToBookmark(SYNCED_ID, ['offline'])).toBeNull();
  });
  expect(JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]')[0].tag_name).toBe('offline');
  await first.unmount();
  const second = await renderStore();
  expect(second.result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).toContain('offline');
  await second.unmount();
});

test('a removed association stays removed across restart and a stale cached snapshot', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })], {
    tags: [{ id: 'remote-tag', user_id: 'user-test', name: 'old', slug: 'old', source: 'user', created_at: 'now' }],
    bookmarkTags: [{ bookmark_id: SYNCED_ID, tag_id: 'remote-tag', source: 'user', confidence: null, created_at: 'now' }],
    collections: [],
  });
  const first = await renderStore();
  await act(async () => {
    expect(await first.result.current.removeTagFromBookmark(SYNCED_ID, 'old')).toBeNull();
  });
  await first.unmount();
  const second = await renderStore();
  expect(second.result.current.getTagsForBookmark(SYNCED_ID)).toEqual([]);
  expect(JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]')[0].op).toBe('remove');
  await second.unmount();
});


test('the durable journal restores an add even if its derived tag snapshot was not written', async () => {
  const spy = jest.spyOn(fakeRepo.repository, 'replaceTagData').mockRejectedValueOnce(new Error('snapshot interrupted'));
  const first = await renderStore();
  try {
    await act(async () => {
      expect(await first.result.current.addTagsToBookmark(SYNCED_ID, ['journal-only'])).toBeNull();
    });
    await first.unmount();
    const second = await renderStore();
    expect(second.result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).toContain('journal-only');
    await second.unmount();
  } finally { spy.mockRestore(); }
});

test('a failed journal write returns an error rather than reporting a durable save', async () => {
  const first = await renderStore();
  const spy = jest.spyOn(fakeRepo.repository, 'setMeta').mockImplementationOnce(async () => { throw new Error('disk full'); });
  try {
    await act(async () => {
      expect(await first.result.current.addTagsToBookmark(SYNCED_ID, ['not-saved'])).toContain('Could not save');
    });
  } finally { spy.mockRestore(); await first.unmount(); }
});
