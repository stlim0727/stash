import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BackHandler, Linking, Platform } from 'react-native';

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
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
    // Run the focus callback as a mount effect (the screen is always focused in
    // these tests); honours the returned cleanup like the real hook.
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { INBOX_VIEW_PREF_KEY } from '@/domain/view-mode';
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
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
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

test('folds the search/sort/view controls away on an empty library', async () => {
  fakeRepo.__reset([]);

  const screen = await renderInbox();

  // Empty first run: the controls are cold chrome over "nothing here yet", so
  // the first screen is all about the first save.
  await waitFor(() =>
    expect(screen.getByText('Nothing saved yet. Add your first bookmark below.')).toBeTruthy(),
  );
  expect(screen.queryByPlaceholderText('Search your stash')).toBeNull();
  expect(screen.queryByTestId('inbox-view-card')).toBeNull();
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

test('announces suggestions that arrived unseen with a banner, dismissable via ✕', async () => {
  const id = '7e64cf1e-0000-4000-8000-00000000000d';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Arrived while away' })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.8 }] })],
  );
  // Simulate a suggestion that landed while the user wasn't looking (persisted
  // unseen marker re-hydrated on launch).
  fakeRepo.__setMeta('unseen_ai_suggestions', JSON.stringify([id]));

  const screen = await renderInbox();

  const banner = await waitFor(() => screen.getByTestId('new-suggestions-banner'));
  expect(screen.getByText('✨ 1 new AI suggestion')).toBeTruthy();
  // While the banner announces, the per-card ✨ badge is suppressed so the same
  // item isn't shouted twice on one screen.
  expect(screen.queryByLabelText('1 AI suggestion')).toBeNull();

  // The ✕ clears the markers, so the banner goes away.
  fireEvent.press(screen.getByLabelText('Dismiss new AI suggestions'));
  await waitFor(() => expect(screen.queryByTestId('new-suggestions-banner')).toBeNull());
  expect(banner).toBeTruthy();
  // ...and with the banner gone, the per-card badge returns as the surviving cue.
  await waitFor(() => expect(screen.getByLabelText('1 AI suggestion')).toBeTruthy());
});

test('the unseen banner counts a folder-only recommendation (no tags)', async () => {
  const id = '7e64cf1e-0000-4000-8000-00000000000f';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder only', collection_id: null })],
    undefined,
    // No tag suggestions, just a proposed (non-existent) collection name.
    [makeEnrichment({ bookmark_id: id, suggested_tags: [], suggested_collection_name: 'Travel' })],
  );
  fakeRepo.__setMeta('unseen_ai_suggestions', JSON.stringify([id]));

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('new-suggestions-banner')).toBeTruthy());
  expect(screen.getByText('✨ 1 new AI suggestion')).toBeTruthy();
});

test('the unseen banner ignores items whose suggestions were already applied', async () => {
  const id = '7e64cf1e-0000-4000-8000-00000000000e';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Already handled' })],
    // The suggested "design" tag is already applied to this bookmark.
    {
      tags: [makeTag('tag-design', 'design')],
      bookmarkTags: [
        {
          bookmark_id: id,
          tag_id: 'tag-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [],
    },
    [makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.8 }] })],
  );
  fakeRepo.__setMeta('unseen_ai_suggestions', JSON.stringify([id]));

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Already handled')).toBeTruthy());
  // No live pending suggestion remains, so the banner never shows.
  expect(screen.queryByTestId('new-suggestions-banner')).toBeNull();
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

test('facet chips carry icons that distinguish collections from tags (#142)', async () => {
  // The "No collection" chip used to sit unmarked among bare collection-name
  // chips and "#tag" chips, so its meaning read as ambiguous (issue #142).
  // Collections now carry a folder icon and the no-collection set a tray icon,
  // so the shelf groups collection filters apart from the "#tag" chips.
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-00000000000a', collection_id: 'col-work' }),
      makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-00000000000b', collection_id: null }),
    ],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Work')).toBeTruthy());

  expect(screen.getByTestId('chip-icon-file-tray-outline')).toBeTruthy();
  expect(screen.getByTestId('chip-icon-folder-outline')).toBeTruthy();
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

test('a routed tag facet overrides a saved Tag-cloud preference and shows the bookmarks', async () => {
  const tagged = '7e64cf1e-0000-4000-8000-000000000071';
  const untagged = '7e64cf1e-0000-4000-8000-000000000072';
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
  // The user's saved layout is the tag cloud …
  await fakeRepo.repository.setMeta(INBOX_VIEW_PREF_KEY, 'cloud');

  const screen = await renderInbox();

  // … but a routed tag facet drills into a bookmark layout so the linked-to
  // bookmark is visible, rather than leaving the global cloud on screen.
  await waitFor(() => expect(screen.getByTestId('inbox-card-title')).toBeTruthy());
  expect(screen.getByText('Design system')).toBeTruthy();
  expect(screen.queryByText('Unrelated note')).toBeNull();
  expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull();
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

test('the sort menu reorders the Inbox by date and name', async () => {
  // Title order disagrees with date order so each choice is observable:
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

  // Default: newest-first by date → apple (Jan 3) before Zebra (Jan 1). The
  // sort pill shows the friendly active-order label.
  expect(titles()).toEqual(['apple', 'Zebra']);

  // Open the sort menu (pill labeled "Newest") and pick "Oldest" → oldest-first.
  await fireEvent.press(screen.getByText('Newest'));
  await fireEvent.press(screen.getByText('Oldest'));
  expect(titles()).toEqual(['Zebra', 'apple']);

  // Reopen (pill now labeled "Oldest") and pick "Name A–Z" → case-insensitive.
  await fireEvent.press(screen.getByText('Oldest'));
  await fireEvent.press(screen.getByText('Name A–Z'));
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

test('the view segmented control switches between card and list layouts', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000041',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // Cards are the default layout.
  expect(screen.getByTestId('inbox-card-title')).toBeTruthy();
  expect(screen.queryByTestId('inbox-list-title')).toBeNull();

  await fireEvent.press(screen.getByTestId('inbox-view-list'));

  // Selecting List renders the same bookmark as a compact list row.
  await waitFor(() => expect(screen.getByTestId('inbox-list-title')).toBeTruthy());
  expect(screen.queryByTestId('inbox-card-title')).toBeNull();
  expect(screen.getByText('Local-first software')).toBeTruthy();

  // Selecting Cards again returns to the card layout.
  await fireEvent.press(screen.getByTestId('inbox-view-card'));
  await waitFor(() => expect(screen.getByTestId('inbox-card-title')).toBeTruthy());
  expect(screen.queryByTestId('inbox-list-title')).toBeNull();
});

test('the tag cloud view lists tags and tapping one filters to that tag', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-000000000061';
  const reading = '7e64cf1e-0000-4000-8000-000000000062';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: cooked, title: 'Kimchi jjigae' }),
      makeStoredBookmark({ id: reading, title: 'Local-first software' }),
    ],
    {
      tags: [makeTag('t-cooking', 'cooking'), makeTag('t-reading', 'reading')],
      bookmarkTags: [
        { bookmark_id: cooked, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: reading, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: reading, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());

  // Switch to the tag cloud: both tags appear, cards are gone.
  await fireEvent.press(screen.getByTestId('inbox-view-cloud'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  expect(screen.queryByTestId('inbox-card-title')).toBeNull();
  const cookingTag = await screen.findByLabelText('#cooking, 2 bookmarks');
  expect(cookingTag).toBeTruthy();
  expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy();

  // Tapping a tag drills in: it filters to that tag and drops back to cards.
  await fireEvent.press(cookingTag);
  await waitFor(() => expect(screen.getByText('#cooking · 2')).toBeTruthy());
  expect(screen.getByText('Kimchi jjigae')).toBeTruthy();
  expect(screen.getByText('Local-first software')).toBeTruthy();
});

test('the tag cloud scopes to the active folder facet', async () => {
  const work = '7e64cf1e-0000-4000-8000-000000000071';
  const home = '7e64cf1e-0000-4000-8000-000000000072';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: work, title: 'Local-first software', collection_id: 'col-work' }),
      makeStoredBookmark({ id: home, title: 'Kimchi jjigae', collection_id: 'col-home' }),
    ],
    {
      tags: [makeTag('t-reading', 'reading'), makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        { bookmark_id: work, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: home, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work'), makeCollection('col-home', 'Home')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // Whole-Inbox cloud shows both folders' tags …
  await fireEvent.press(screen.getByTestId('inbox-view-cloud'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy();
  expect(screen.getByLabelText('#cooking, 1 bookmark')).toBeTruthy();

  // … picking the Work folder chip narrows the cloud to that folder's tags.
  await fireEvent.press(screen.getByText('Work'));
  await waitFor(() => expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy());
  expect(screen.queryByLabelText('#cooking, 1 bookmark')).toBeNull();
});

test('the hardware back key returns from a drilled-in tag to the tag cloud', async () => {
  // The handler only registers on Android (where hardware Back exists).
  const originalOS = Platform.OS;
  Platform.OS = 'android';
  // Capture the screen's hardwareBackPress handler so we can fire it directly
  // (there is no real device back button in the test environment).
  const handlers: Array<() => boolean> = [];
  const addSpy = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, cb) => {
      if (event === 'hardwareBackPress') {
        handlers.push(cb as () => boolean);
      }
      return { remove: () => {} } as ReturnType<typeof BackHandler.addEventListener>;
    });

  try {
    const cooked = '7e64cf1e-0000-4000-8000-000000000081';
    const reading = '7e64cf1e-0000-4000-8000-000000000082';
    fakeRepo.__reset(
      [
        makeStoredBookmark({ id: cooked, title: 'Kimchi jjigae' }),
        makeStoredBookmark({ id: reading, title: 'Local-first software' }),
      ],
      {
        tags: [makeTag('t-cooking', 'cooking'), makeTag('t-reading', 'reading')],
        bookmarkTags: [
          { bookmark_id: cooked, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
          { bookmark_id: reading, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        ],
        collections: [],
      },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());

    // Open the cloud and drill into a tag → filtered cards, cloud gone.
    await fireEvent.press(screen.getByTestId('inbox-view-cloud'));
    await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
    await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
    await waitFor(() => expect(screen.getByText('#cooking · 1')).toBeTruthy());
    expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull();

    const onBack = handlers[handlers.length - 1];
    expect(onBack).toBeDefined();

    // Back consumes the press and restores the tag cloud instead of exiting.
    let handled: boolean | undefined;
    await act(async () => {
      handled = onBack();
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());

    // A second press is no longer consumed — there is nothing left to undo, so
    // the OS gets the press (app may background/exit) as usual.
    await act(async () => {
      handled = onBack();
    });
    expect(handled).toBe(false);
  } finally {
    addSpy.mockRestore();
    Platform.OS = originalOS;
  }
});

test('blank-named tags and collections do not produce empty filter chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-000000000050';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Korean video', collection_id: 'col-blank' })],
    {
      // A tag/collection with an empty or whitespace name must not render as a
      // blank pill in the Browse shelf.
      tags: [makeTag('t-blank', '   '), makeTag('t-real', 'cooking')],
      bookmarkTags: [
        { bookmark_id: id, tag_id: 't-blank', source: 'ai', confidence: 0.9, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: id, tag_id: 't-real', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-blank', '  ')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Korean video')).toBeTruthy());

  // The real tag chip renders; the blank ones are dropped.
  expect(screen.getByRole('button', { name: '#cooking' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '#' })).toBeNull();
  expect(screen.queryByRole('button', { name: '#   ' })).toBeNull();
});

test('long-pressing an inbox card opens the action menu and Move to Trash removes the item', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000061',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // Long-press surfaces the contextual actions without leaving the Inbox.
  await fireEvent(screen.getByTestId('inbox-card-title'), 'longPress');
  expect(screen.getByText('Open link')).toBeTruthy();
  expect(screen.getByText('Move to collection…')).toBeTruthy();
  expect(screen.getByText('Move to Trash')).toBeTruthy();

  // Moving to trash files it away, so it drops out of the (non-archived) Inbox.
  await fireEvent.press(screen.getByText('Move to Trash'));
  await waitFor(() => expect(screen.queryByText('Local-first software')).toBeNull());

  // ...but a confirmation toast offers an immediate Undo, which restores it
  // (the recovery path is otherwise buried in Settings → Trash).
  const undo = await screen.findByText('Undo');
  await act(async () => {
    fireEvent.press(undo);
  });
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
});

test('long-pressing the preview image (not just the title) opens the action menu', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000063',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
      preview_image_url: 'https://example.com/preview.png',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByTestId('inbox-card-preview')).toBeTruthy());

  // The whole card (image included) is the long-press target, not only the title.
  await fireEvent(screen.getByTestId('inbox-card-preview'), 'longPress');
  expect(screen.getByText('Move to Trash')).toBeTruthy();
});

test('the action menu Open link opens the bookmark URL', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000062',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  await fireEvent(screen.getByTestId('inbox-card-title'), 'longPress');
  await fireEvent.press(screen.getByText('Open link'));

  expect(openURL).toHaveBeenCalledWith('https://www.inkandswitch.com/local-first/');
  openURL.mockRestore();
});

test('shows the no-matches empty state for an unmatched search', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search your stash'), 'zzz');

  expect(screen.getByText('No bookmarks match your search.')).toBeTruthy();
});
