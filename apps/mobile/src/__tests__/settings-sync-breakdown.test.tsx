import {
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockAuth = {
  status: 'anonymous' as const,
  email: null,
  displayName: null,
  avatarUrl: null,
  isSignedIn: true,
  userId: 'user-1',
  message: '',
  signIn: jest.fn(async () => ({ ok: true })),
  signOut: jest.fn(async () => {}),
  ensureAnonymousSession: jest.fn(async () => null),
};
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: () => new Promise(() => {}),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));
jest.mock('@/share/export-data', () => ({
  deliverExport: jest.fn(async () => {}),
}));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';
import {
  makeStoredBookmark,
  type FakeRepositoryModule,
} from './helpers/fake-repository';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const NOW = '2026-08-03T00:00:00.000Z';

function queueEntry(
  id: string,
  status: LocalPendingBookmark['sync_status'] = 'pending',
): LocalPendingBookmark {
  return {
    local_id: id,
    remote_id: null,
    operation: 'create',
    payload: { id, url: `https://example.com/${id}` },
    sync_status: status,
    retry_count: status === 'failed' ? 3 : 0,
    last_error: status === 'failed' ? 'network error' : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seed(options: {
  rows?: Bookmark[];
  queue?: LocalPendingBookmark[];
  meta?: Record<string, string>;
}) {
  fakeRepo.__reset(options.rows ?? []);
  for (const entry of options.queue ?? []) {
    await fakeRepo.repository.enqueue(entry);
  }
  for (const [key, value] of Object.entries(options.meta ?? {})) {
    await fakeRepo.repository.setMeta(key, value);
  }
}

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

function expectRow(
  screen: Awaited<ReturnType<typeof render>>,
  testID: string,
  value: string | RegExp,
) {
  expect(within(screen.getByTestId(testID)).getByText(value)).toBeTruthy();
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
});

test('the four exclusive stage counts add up to the headline total', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'metadata', metadata_status: 'pending' })],
    queue: [queueEntry('cloud')],
    meta: { pending_ai_trigger: JSON.stringify(['ai']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expectRow(screen, 'processing-summary', '3 bookmarks remaining'));

  expectRow(screen, 'processing-stage-cloud', /^1 bookmark(?: · saving now)?$/);
  expectRow(screen, 'processing-stage-metadata', '1 bookmark');
  expectRow(screen, 'processing-stage-ai', '1 bookmark');
  expectRow(screen, 'processing-stage-attention', '0 bookmarks');
});

test('failed cloud work is surfaced as attention instead of ordinary progress', async () => {
  await seed({ queue: [queueEntry('failed', 'failed')] });

  const screen = await renderSettings();
  await waitFor(() =>
    expectRow(
      screen,
      'processing-summary',
      '1 bookmark remaining · 1 needs attention',
    ),
  );

  expectRow(screen, 'processing-stage-cloud', '0 bookmarks');
  expectRow(screen, 'processing-stage-attention', '1 bookmark');
});

test('processing details keep raw overlapping counters for diagnosis', async () => {
  const id = 'overlap';
  await seed({
    rows: [makeStoredBookmark({ id, metadata_status: 'pending' })],
    queue: [queueEntry(id)],
    meta: { pending_ai_trigger: JSON.stringify([id]) },
  });

  const screen = await renderSettings();
  await waitFor(() => screen.getByTestId('processing-summary'));
  await fireEvent.press(screen.getByText('Processing details'));

  await waitFor(() =>
    expect(screen.getByText('pending 1 · syncing 0 · failed 0')).toBeTruthy(),
  );
  expect(screen.getByText('pending 1 · failed 0 · skipped 0')).toBeTruthy();
  expect(
    screen.getByText('trigger 1 · dispatch 0 · retry 0 · active 0'),
  ).toBeTruthy();
});

test('sync pause is a modifier on the cloud count, not another counter', async () => {
  await seed({
    queue: [queueEntry('cloud')],
    meta: { 'pref.sync.paused': 'true' },
  });

  const screen = await renderSettings();
  await waitFor(() =>
    expectRow(screen, 'processing-stage-cloud', '1 bookmark · sync paused'),
  );
  expectRow(screen, 'processing-summary', '1 bookmark remaining');
});
