import { fireEvent, render, waitFor } from '@testing-library/react-native';
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

const mockNavigate = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => ({
      navigate: mockNavigate,
      push: mockPush,
      replace: jest.fn(),
      back: jest.fn(),
      dismissTo: jest.fn(),
    }),
    // The screen resets the shared scroll signal on focus; run it as a mount
    // effect (the screen is always focused in these tests).
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
    // `tags.tsx` imports TAB_BAR_HEIGHT from `./_layout`, which pulls `Tabs` from
    // expo-router at module load; a harmless stub keeps that import happy.
    Tabs: Object.assign(() => null, { Screen: () => null }),
  };
});

import TagsScreen from '@/app/(tabs)/tags';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Tag } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeTag(id: string, name: string): Tag {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, slug: name, source: 'user', created_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderTags() {
  return render(
    <BookmarksProvider>
      <TagsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockPush.mockClear();
});

// A small library: two bookmarks, three tags. "cooking" is on both (count 2),
// "reading" and "travel" on one each.
function seedLibrary() {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000a1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000a2';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: cooked, title: 'Kimchi jjigae' }),
      makeStoredBookmark({ id: reading, title: 'Local-first software' }),
    ],
    {
      tags: [
        makeTag('t-cooking', 'cooking'),
        makeTag('t-reading', 'reading'),
        makeTag('t-travel', 'travel'),
      ],
      bookmarkTags: [
        { bookmark_id: cooked, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: reading, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: reading, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: cooked, tag_id: 't-travel', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );
}

test('renders every tag with its per-tag count, and a header total', async () => {
  seedLibrary();

  const screen = await renderTags();

  // Each tag is a row keyed by its id.
  await waitFor(() => expect(screen.getByTestId('tags-row-t-cooking')).toBeTruthy());
  expect(screen.getByText('#cooking')).toBeTruthy();
  expect(screen.getByText('#reading')).toBeTruthy();
  expect(screen.getByText('#travel')).toBeTruthy();

  // Per-tag counts: cooking is on 2 bookmarks, the others on 1 each.
  expect(screen.getByText('2 items')).toBeTruthy();
  expect(screen.getAllByText('1 item')).toHaveLength(2);

  // Header total counts the distinct tags.
  expect(screen.getByText('3 tags')).toBeTruthy();
});

test('tapping a tag opens the Inbox tab scoped to that tag', async () => {
  seedLibrary();

  const screen = await renderTags();
  await waitFor(() => expect(screen.getByTestId('tags-row-t-cooking')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('tags-row-t-cooking'));

  // It hands the Inbox tab the tag facet (with a fresh nonce) so the items
  // render there with the existing cards — no items rendered inline.
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/',
    params: { tag: 't-cooking', t: expect.any(String) },
  });
});

test('renders the shared top-right header cluster: search + settings icons', async () => {
  seedLibrary();

  const screen = await renderTags();
  await waitFor(() => expect(screen.getByTestId('tab-header-search')).toBeTruthy());
  expect(screen.getByTestId('tab-header-settings')).toBeTruthy();
});

test('the header search icon navigates to the Inbox with a focusSearch param', async () => {
  seedLibrary();

  const screen = await renderTags();
  await waitFor(() => expect(screen.getByTestId('tab-header-search')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('tab-header-search'));
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/',
    params: { focusSearch: '1', t: expect.any(String) },
  });
});

test('the header settings icon opens the Settings screen', async () => {
  seedLibrary();

  const screen = await renderTags();
  await waitFor(() => expect(screen.getByTestId('tab-header-settings')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('tab-header-settings'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

test('shows the calm empty state when there are no tags yet', async () => {
  // A library with bookmarks but no tags: Tags is still empty (never a debt
  // framing), just an invitation.
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000b1', title: 'Untagged link' }),
  ]);

  const screen = await renderTags();

  await waitFor(() => expect(screen.getByTestId('tags-empty')).toBeTruthy());
  expect(screen.getByText('Your topics gather here')).toBeTruthy();
  // No tag rows on an empty index.
  expect(screen.queryByTestId('tags-row-t-cooking')).toBeNull();
});
