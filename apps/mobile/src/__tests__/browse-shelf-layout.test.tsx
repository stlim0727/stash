/**
 * Layout regression guards for the Browse facet shelf (the horizontal chip row
 * under "BROWSE": All / No collection / collections / #tags).
 *
 * On Android a horizontal ScrollView can collapse its viewport onto its content
 * and clip the chips' bottom edge, and vertical padding on the content
 * container makes it worse (see the comments on `styles.shelf`). These guards
 * lock in the two invariants that fixed it (PR #62):
 *   1. the shelf ScrollView has an explicit height, so the viewport can't
 *      collapse below a chip's height;
 *   2. the shelf content container has NO vertical padding (spacing must be
 *      margin, which lives outside the scroll box and can't clip).
 */
import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';

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
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Collection } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

async function renderShelf() {
  // A collection produces a facet chip, which makes the Browse shelf visible.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-00000000000a', collection_id: 'col-work' })],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );
  const screen = await render(
    <BookmarksProvider>
      <InboxScreen />
    </BookmarksProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('browse-shelf')).toBeTruthy());
  return screen.getByTestId('browse-shelf');
}

test('browse shelf reserves a vertical floor (Android viewport-collapse guard)', async () => {
  const shelf = await renderShelf();
  const style = StyleSheet.flatten(shelf.props.style) as ViewStyle;

  // Either a fixed height or a minHeight reserves the floor that stops the
  // horizontal ScrollView from collapsing onto its content. minHeight is
  // preferred (it grows with larger fonts instead of clipping), but accept
  // either so this guards the invariant, not the exact property.
  const floor = style.minHeight ?? style.height;
  expect(typeof floor).toBe('number');
});

test('browse shelf content has no vertical padding (Android clip trap)', async () => {
  const shelf = await renderShelf();
  const content = StyleSheet.flatten(shelf.props.contentContainerStyle) as ViewStyle;

  expect(content.paddingVertical).toBeUndefined();
  expect(content.paddingTop).toBeUndefined();
  expect(content.paddingBottom).toBeUndefined();
});
