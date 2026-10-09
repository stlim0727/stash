import './helpers/ai-enrichment-harness';
import type { LocalPendingBookmark } from '@/domain/types';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);

function stalledEntry(): LocalPendingBookmark {
  return {
    local_id: SYNCED_ID,
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://example.com/stored', collection_id: 'previous-account-folder' },
    sync_status: 'failed',
    retry_count: 8,
    last_error: 'new row violates row-level security policy',
    last_error_kind: 'permission',
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
}

async function seedStalledCapture() {
  await fakeRepo.repository.updateBookmark(makeStoredBookmark({
    id: SYNCED_ID, collection_id: 'previous-account-folder', sync_status: 'failed',
  }));
  await fakeRepo.repository.enqueue(stalledEntry());
}

test('cold hydration durably repairs a stalled collection permission failure while sync is paused', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await seedStalledCapture();
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(fakeRepo.__queue()[0]).toMatchObject({
    sync_status: 'pending', retry_count: 0, last_error: null, last_error_kind: null,
  }));
  expect(fakeRepo.__queue()[0].payload).not.toHaveProperty('collection_id');
  expect(fakeRepo.__bookmarks()[0]).toMatchObject({ collection_id: null, sync_status: 'pending' });
  expect(store.current?.inbox[0].collection_id).toBeNull();
  expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
});

test('sync reload repairs durable stalled work before automatic retry eligibility and upload', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await seedStalledCapture();
  apiMock.__spies.createBookmark.mockImplementationOnce(async (input: Record<string, unknown>) => {
    expect(input).not.toHaveProperty('collection_id', 'previous-account-folder');
    expect(fakeRepo.__queue()[0]).toMatchObject({ sync_status: 'pending', retry_count: 0 });
    expect(fakeRepo.__bookmarks()[0].collection_id).toBeNull();
    return { bookmark_id: SYNCED_ID };
  });
  await act(async () => { store.current!.setSyncPaused(false); });
  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
});
