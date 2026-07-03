import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { Collection, Tag } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

function makeTag(id: string, name: string): Tag {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, slug: name, source: 'user', created_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

const DEFAULT_PLACEHOLDER = 'Search titles, tags, folders';

function renderInbox() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

/**
 * One foldered+tagged bookmark plus one uncollected bookmark, so the browse
 * shelf surfaces a folder chip (Work), a #tag chip (#design), an Inbox
 * (no-collection) chip, and the All chip — every facet the placeholder can scope to.
 */
function seedFacetedLibrary() {
  const foldered = '7e64cf1e-0000-4000-8000-0000000000d1';
  const loose = '7e64cf1e-0000-4000-8000-0000000000d2';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: foldered, title: 'Design system', collection_id: 'col-work' }),
      makeStoredBookmark({ id: loose, title: 'Loose note', collection_id: null }),
    ],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        {
          bookmark_id: foldered,
          tag_id: 't-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );
}

test('the placeholder scopes to the active facet and reverts to the default on All', async () => {
  seedFacetedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  // Browse-shelf chips share their text with on-card meta chips (e.g. `#design`),
  // so always tap the chip *inside* the browse shelf.
  const tapBrowseChip = async (label: string) => {
    const shelf = screen.getByTestId('browse-shelf');
    await act(async () => {
      fireEvent.press(within(shelf).getByText(label));
    });
  };

  // All (default): the generic placeholder, no scoping.
  expect(screen.getByPlaceholderText(DEFAULT_PLACEHOLDER)).toBeTruthy();

  // Folder facet → "Search in {folder name}".
  await tapBrowseChip('Work');
  await waitFor(() => expect(screen.getByPlaceholderText('Search in Work')).toBeTruthy());
  expect(screen.queryByPlaceholderText(DEFAULT_PLACEHOLDER)).toBeNull();

  // Tag facet → "Search in #{tag}".
  await tapBrowseChip('#design');
  await waitFor(() => expect(screen.getByPlaceholderText('Search in #design')).toBeTruthy());

  // Uncollected facet → the fixed "Search in Inbox" label.
  await tapBrowseChip('Inbox');
  await waitFor(() => expect(screen.getByPlaceholderText('Search in Inbox')).toBeTruthy());

  // Clearing the facet (All chip) reverts to the default with no stale scope.
  await tapBrowseChip('All');
  await waitFor(() => expect(screen.getByPlaceholderText(DEFAULT_PLACEHOLDER)).toBeTruthy());
  expect(screen.queryByPlaceholderText('Search in Work')).toBeNull();
});

test('the search banner names the facet the search is scoped to', async () => {
  seedFacetedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  const tapBrowseChip = async (label: string) => {
    // The browse shelf folds away while a search is active (the slimmed
    // search-results header), so switching facets between searches waits for the
    // cleared query to settle and the shelf to remount before tapping.
    const shelf = await waitFor(() => screen.getByTestId('browse-shelf'));
    await act(async () => {
      fireEvent.press(within(shelf).getByText(label));
    });
  };
  const search = async (text: string) => {
    const input = screen.getByTestId('inbox-search-input');
    await act(async () => {
      fireEvent.changeText(input, text);
    });
  };

  // Folder facet: the banner names the folder it's searching within.
  await tapBrowseChip('Work');
  await search('Design');
  let bar = await waitFor(() => screen.getByTestId('inbox-filter-bar'));
  await waitFor(() => expect(within(bar).getByText('Results for “Design” in Work')).toBeTruthy());

  // Inbox (no-collection) facet: the fixed "Inbox" scope name (the reported case).
  await search('');
  await tapBrowseChip('Inbox');
  await search('Loose');
  bar = await waitFor(() => screen.getByTestId('inbox-filter-bar'));
  await waitFor(() => expect(within(bar).getByText('Results for “Loose” in Inbox')).toBeTruthy());

  // All (no facet): the bare banner with no scope clause.
  await search('');
  await tapBrowseChip('All');
  await search('Design');
  bar = await waitFor(() => screen.getByTestId('inbox-filter-bar'));
  await waitFor(() => expect(within(bar).getByText('Results for “Design”')).toBeTruthy());
});

test('the scoped placeholder coexists with the focus-empty suggestion shelf', async () => {
  seedFacetedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  // Narrow to the Work folder so the placeholder is scoped.
  await act(async () => {
    fireEvent.press(within(screen.getByTestId('browse-shelf')).getByText('Work'));
  });
  const input = await waitFor(() => screen.getByPlaceholderText('Search in Work'));

  // Focusing the (still empty) field shows the suggestion shelf — the scoped
  // placeholder must not suppress it.
  await act(async () => {
    fireEvent(input, 'focus');
  });
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  // …and the placeholder is unchanged: scope label and shelf are independent.
  expect(screen.getByPlaceholderText('Search in Work')).toBeTruthy();
});
