import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

// Router/navigation doubles, re-created per test so the navigate/back spies are
// inspectable. `mockParams` is the route's scope param.
let mockParams: Record<string, string> = {};
const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
const mockSetOptions = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    navigate: mockNavigate,
    replace: jest.fn(),
    back: mockBack,
  }),
  useNavigation: () => ({
    setOptions: mockSetOptions,
    canGoBack: () => mockCanGoBack,
  }),
  useLocalSearchParams: () => mockParams,
}));

import BrowseTagsScreen from '@/app/browse/tags';
import { BookmarksProvider } from '@/store/bookmarks';
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

function renderScreen() {
  return render(
    <BookmarksProvider>
      <BrowseTagsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockParams = {};
  mockNavigate.mockClear();
  mockPush.mockClear();
  mockBack.mockClear();
  mockSetOptions.mockClear();
  mockCanGoBack = true;
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
      tags: [makeTag('t-cooking', 'cooking'), makeTag('t-reading', 'reading'), makeTag('t-travel', 'travel')],
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

test('renders the cloud (default surface) and toggling to All lists every tag with count badges', async () => {
  seedLibrary();

  const screen = await renderScreen();

  // Cloud is the default surface: each tag is a pressable.
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());
  expect(await screen.findByLabelText('#cooking, 2 bookmarks')).toBeTruthy();
  expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy();
  expect(screen.getByLabelText('#travel, 1 bookmark')).toBeTruthy();

  // Toggle to the full list: all three tags render as rows with count badges.
  await fireEvent.press(screen.getByTestId('browse-tags-view-all'));
  await waitFor(() => expect(screen.getByTestId('browse-tags-list')).toBeTruthy());
  const rows = screen.getAllByTestId('browse-tags-list-row');
  expect(rows).toHaveLength(3);
  // The muted count badges (one per row).
  expect(screen.getByText('· 2')).toBeTruthy();
  expect(screen.getAllByText('· 1')).toHaveLength(2);
});

test('the cloud caps how many tags it renders at the conservative floor before measure', async () => {
  // Many tags on one bookmark: before the container's onLayout fires (no layout
  // event in the test env), the adaptive cap stays at its conservative floor.
  const bookmarkId = '7e64cf1e-0000-4000-8000-0000000000b0';
  const tagCount = 60;
  const tags: Tag[] = [];
  const bookmarkTags = [];
  for (let i = 0; i < tagCount; i += 1) {
    const suffix = String(i).padStart(3, '0');
    const tagId = `t-${suffix}`;
    tags.push(makeTag(tagId, `tag-${suffix}`));
    bookmarkTags.push({
      bookmark_id: bookmarkId,
      tag_id: tagId,
      source: 'user' as const,
      confidence: null,
      created_at: '2026-06-12T00:00:00.000Z',
    });
  }
  fakeRepo.__reset([makeStoredBookmark({ id: bookmarkId, title: 'Heavily tagged' })], {
    tags,
    bookmarkTags,
    collections: [],
  });

  const screen = await renderScreen();

  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());
  // The cloud renders only the conservative floor (24) of the busiest tags …
  expect(screen.getAllByTestId('browse-tags-cloud-tag')).toHaveLength(24);

  // … while the full list is a virtualized FlatList over every tag. The list
  // only mounts its initial window of rows in the test env, but it's backed by
  // the full ranked set (its data length), so the busiest tag (tag-000, the
  // first frequency-ranked entry) is in the first window.
  await fireEvent.press(screen.getByTestId('browse-tags-view-all'));
  const list = await waitFor(() => screen.getByTestId('browse-tags-list'));
  expect(list.props.data).toHaveLength(tagCount);
  expect(screen.getAllByTestId('browse-tags-list-row').length).toBeGreaterThan(0);
});

test('the co-occurrence search narrows to the tags on matching bookmarks', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());

  // Searching "kimchi" matches only the cooked bookmark, so the cloud collapses
  // to that bookmark's tags (cooking + travel), dropping reading.
  await fireEvent.changeText(screen.getByTestId('browse-tags-search'), 'kimchi');
  await waitFor(() => expect(screen.queryByLabelText('#reading, 1 bookmark')).toBeNull());
  expect(screen.getByLabelText('#cooking, 1 bookmark')).toBeTruthy();
  expect(screen.getByLabelText('#travel, 1 bookmark')).toBeTruthy();
});

test('a search that matches nothing shows the search-zero copy', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());

  await fireEvent.changeText(screen.getByTestId('browse-tags-search'), 'zzzznope');
  await waitFor(() => expect(screen.getByText('No tags match “zzzznope”.')).toBeTruthy());
  expect(screen.queryByTestId('browse-tags-cloud')).toBeNull();
});

test('a folder scope with no tags shows scoped-empty and a "Browse all tags" recovery', async () => {
  // The scoped folder holds a bookmark with NO tags, so the scope is tag-empty
  // (but not library-empty → no auto-back).
  const filed = '7e64cf1e-0000-4000-8000-0000000000c1';
  const elsewhere = '7e64cf1e-0000-4000-8000-0000000000c2';
  mockParams = { scope: 'collection:col-work' };
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: filed, title: 'Untagged work doc', collection_id: 'col-work' }),
      makeStoredBookmark({ id: elsewhere, title: 'Tagged elsewhere', collection_id: null }),
    ],
    {
      tags: [makeTag('t-reading', 'reading')],
      bookmarkTags: [
        { bookmark_id: elsewhere, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  const screen = await renderScreen();

  await waitFor(() => expect(screen.getByText('No tags in Work yet.')).toBeTruthy());
  // The recovery drops the facet by re-navigating to the unscoped route.
  await fireEvent.press(screen.getByTestId('browse-tags-browse-all'));
  expect(mockNavigate).toHaveBeenCalledWith('/browse/tags');
  // The auto-back library-empties guard must NOT have fired (the scope has a
  // bookmark, it's just untagged).
  expect(mockBack).not.toHaveBeenCalled();
});

test('tapping a cloud tag navigates to the root Inbox with that tag facet', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());

  await fireEvent.press(await screen.findByLabelText('#cooking, 2 bookmarks'));
  expect(mockNavigate).toHaveBeenCalledTimes(1);
  const [arg] = mockNavigate.mock.calls[0];
  expect(arg.pathname).toBe('/');
  expect(arg.params.tag).toBe('t-cooking');
  // A monotonic nonce rides along so a same-tag re-tap on return re-applies.
  expect(arg.params.t).toBeTruthy();
});

test('re-tapping the SAME tag fires a fresh navigate (with a new nonce) each time', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());

  const tag = await screen.findByLabelText('#cooking, 2 bookmarks');
  await fireEvent.press(tag);
  await fireEvent.press(tag);

  expect(mockNavigate).toHaveBeenCalledTimes(2);
  const firstNonce = mockNavigate.mock.calls[0][0].params.t;
  const secondNonce = mockNavigate.mock.calls[1][0].params.t;
  // Same tag both times …
  expect(mockNavigate.mock.calls[0][0].params.tag).toBe('t-cooking');
  expect(mockNavigate.mock.calls[1][0].params.tag).toBe('t-cooking');
  // … but a fresh nonce, so the root Inbox re-applies on the second return.
  expect(secondNonce).not.toBe(firstNonce);
});

test('drilling in from a folder-scoped route still applies the all-library tag facet', async () => {
  // InboxFilter has no compound tag+folder, so a tag tapped while folder-scoped
  // widens to the whole-library tag facet (documented behavior).
  const filed = '7e64cf1e-0000-4000-8000-0000000000d1';
  mockParams = { scope: 'collection:col-work' };
  fakeRepo.__reset(
    [makeStoredBookmark({ id: filed, title: 'Work doc', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        { bookmark_id: filed, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('browse-tags-cloud')).toBeTruthy());

  await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
  const [arg] = mockNavigate.mock.calls[0];
  // Just the tag facet — no scope/collection carried into the drill-in.
  expect(arg.params.tag).toBe('t-cooking');
  expect(arg.params.collection).toBeUndefined();
});

test('an empty underlying scope pops back to the previous screen', async () => {
  // The folder scope has no bookmarks at all → nothing to browse → auto-back.
  mockParams = { scope: 'collection:col-empty' };
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e1', title: 'Loose', collection_id: null })],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-empty', 'Empty')] },
  );

  await renderScreen();

  await waitFor(() => expect(mockBack).toHaveBeenCalled());
});

test('the empties-back guard does not crash when this is the only screen in the stack', async () => {
  // Cold deep-link into an empty scope with nothing behind it: canGoBack is
  // false, so the guard must not call back() (and must not throw).
  mockCanGoBack = false;
  mockParams = { scope: 'collection:col-empty' };
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e2', title: 'Loose', collection_id: null })],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-empty', 'Empty')] },
  );

  const screen = await renderScreen();

  // No crash, no back() — the screen simply stays mounted.
  await waitFor(() => expect(screen.getByTestId('browse-tags-screen')).toBeTruthy());
  // Give the empties effect a chance to (not) fire.
  await act(async () => {});
  expect(mockBack).not.toHaveBeenCalled();
});

test('the header title reflects the active facet scope', async () => {
  mockParams = { scope: 'collection:col-work' };
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f1', title: 'Work doc', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        { bookmark_id: '7e64cf1e-0000-4000-8000-0000000000f1', tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  await renderScreen();

  await waitFor(() =>
    expect(mockSetOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tags in Work' })),
  );
});
