import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';

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
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Collection, Tag } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

function makeTag(id: string, name: string): Tag {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, slug: name, source: 'user', created_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderInbox() {
  return render(
    <BookmarksProvider>
      <InboxScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockParams = {};
});

test('renders stored bookmarks with their titles', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000b',
      title: 'Raindrop review',
      url: 'https://raindrop.io/',
      url_hash: 'https://raindrop.io/',
    }),
  ]);

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
  expect(screen.getByText('Raindrop review')).toBeTruthy();
});

test('shows an AI suggestion badge for pending (un-applied) suggested tags', async () => {
  const id = '7e64cf1e-0000-4000-8000-00000000000c';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'A bookmark with suggestions' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('A bookmark with suggestions')).toBeTruthy());
  expect(screen.getByLabelText('2 AI suggestions')).toBeTruthy();
});

test('search filters the list and shows the match count', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000b',
      title: 'Raindrop review',
      url: 'https://raindrop.io/',
      url_hash: 'https://raindrop.io/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search your stash'), 'local-first');

  expect(screen.getByText('Matches (1)')).toBeTruthy();
  expect(screen.getByText('Local-first software')).toBeTruthy();
  expect(screen.queryByText('Raindrop review')).toBeNull();
});

test('the card Open action opens the bookmark URL in the system browser', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  fakeRepo.__reset([
    makeStoredBookmark({
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Open link'));

  expect(openURL).toHaveBeenCalledWith('https://www.inkandswitch.com/local-first/');
  openURL.mockRestore();
});

test('the collection chip filters the Inbox to that collection', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000a',
        title: 'Work doc',
        collection_id: 'col-work',
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000b',
        title: 'Loose link',
        collection_id: null,
      }),
    ],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Work doc')).toBeTruthy());
  expect(screen.getByText('Loose link')).toBeTruthy();

  await fireEvent.press(screen.getByText('Work'));

  expect(screen.getByText('Work doc')).toBeTruthy();
  expect(screen.queryByText('Loose link')).toBeNull();

  await fireEvent.press(screen.getByText('No collection'));
  expect(screen.getByText('Loose link')).toBeTruthy();
  expect(screen.queryByText('Work doc')).toBeNull();
});

test('the tag chip filters the Inbox to bookmarks with that tag', async () => {
  const tagged = '7e64cf1e-0000-4000-8000-00000000000c';
  const untagged = '7e64cf1e-0000-4000-8000-00000000000d';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: tagged, title: 'Design system' }),
      makeStoredBookmark({ id: untagged, title: 'Unrelated note' }),
    ],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        { bookmark_id: tagged, tag_id: 't-design', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  // The facet chip (a button) — disambiguated from the card's inline #design meta.
  await fireEvent.press(screen.getByRole('button', { name: '#design' }));

  expect(screen.getByText('Design system')).toBeTruthy();
  expect(screen.queryByText('Unrelated note')).toBeNull();
});

test('a tag route param filters the Inbox to that tag on load', async () => {
  const tagged = '7e64cf1e-0000-4000-8000-00000000000e';
  const untagged = '7e64cf1e-0000-4000-8000-00000000000f';
  mockParams = { tag: 't-design' };
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: tagged, title: 'Design system' }),
      makeStoredBookmark({ id: untagged, title: 'Unrelated note' }),
    ],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        { bookmark_id: tagged, tag_id: 't-design', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  expect(screen.queryByText('Unrelated note')).toBeNull();
  expect(screen.getByText('#design · 1')).toBeTruthy();
});

test('cards show inline collection and tag metadata', async () => {
  const id = '7e64cf1e-0000-4000-8000-000000000010';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Design system', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        { bookmark_id: id, tag_id: 't-design', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  expect(screen.getByText('in Work')).toBeTruthy();
  expect(screen.getAllByText('#design').length).toBeGreaterThan(0);
});

test('the sort control reorders the Inbox by date and name', async () => {
  // Title order disagrees with date order so each toggle is observable:
  // 'apple' is the newest, 'Zebra' is the oldest.
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000021',
      title: 'apple',
      created_at: '2026-01-03T00:00:00.000Z',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000022',
      title: 'Zebra',
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('apple')).toBeTruthy());

  const titles = () =>
    screen.getAllByTestId('inbox-card-title').map((node) => node.props.children);

  // Default: newest-first by date → apple (Jan 3) before Zebra (Jan 1).
  expect(titles()).toEqual(['apple', 'Zebra']);

  // Flip direction → oldest-first by date → Zebra before apple.
  await fireEvent.press(screen.getByText('↓ Desc'));
  expect(titles()).toEqual(['Zebra', 'apple']);

  // Switch field to Name (still ascending) → case-insensitive A–Z.
  await fireEvent.press(screen.getByText('Newest'));
  expect(titles()).toEqual(['apple', 'Zebra']);
});

test('every card shows an icon — favicon when present, else a domain monogram', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000031',
      title: 'Has favicon',
      favicon_url: 'https://cdn.example/icon.png',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000032',
      title: 'No favicon',
      favicon_url: null,
      url: 'https://www.raindrop.io/',
      url_hash: 'https://www.raindrop.io/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('No favicon')).toBeTruthy());

  // The favicon-less card falls back to a monogram of its domain (raindrop.io → R).
  const monograms = screen.getAllByTestId('inbox-card-monogram');
  expect(monograms).toHaveLength(1);
  expect(screen.getByText('R')).toBeTruthy();
});

test('shows the no-matches empty state for an unmatched search', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search your stash'), 'zzz');

  expect(screen.getByText('No bookmarks match your search.')).toBeTruthy();
});
