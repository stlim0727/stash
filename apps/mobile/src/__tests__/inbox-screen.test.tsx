import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
  // the first screen is all about the first save — an onboarding card that
  // teaches the share-sheet capture, with the chrome folded away.
  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(
    screen.getByText('Share a link from any app and pick Stash to save it in a tap.'),
  ).toBeTruthy();
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

test('the per-card ✨ badge counts a folder-only recommendation (no tags)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000f1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder only', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [], suggested_collection_name: 'Travel' })],
  );
  // No unseen marker, so the banner is absent and the per-card badge is the cue.

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Folder only')).toBeTruthy());
  // The folder counts toward the badge even with zero pending tags — matching the
  // banner/Settings/Review inclusion rule (regression: the badge ignored folders).
  expect(screen.getByLabelText('1 AI suggestion')).toBeTruthy();
});

test('a durably-dismissed folder drops the per-card ✨ badge', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000f2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder only', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [], suggested_collection_name: 'Travel' })],
  );
  // The folder was dismissed earlier (on any screen) — durable, cross-screen.
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [id]: ['name:travel'] }));

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Folder only')).toBeTruthy());
  // No pending tag and the folder is dismissed → nothing to badge.
  expect(screen.queryByLabelText('1 AI suggestion')).toBeNull();
});

test('the unseen banner ignores a folder-only item whose folder was dismissed', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000f3';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder only', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [], suggested_collection_name: 'Travel' })],
  );
  fakeRepo.__setMeta('unseen_ai_suggestions', JSON.stringify([id]));
  // The only recommendation (the folder) was already dismissed durably.
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [id]: ['name:travel'] }));

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Folder only')).toBeTruthy());
  // Nothing live remains to review, so the banner stays down despite the marker.
  expect(screen.queryByTestId('new-suggestions-banner')).toBeNull();
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

  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'local-first');

  // The derived query is debounced, so the count/filter settle a beat later.
  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  expect(screen.getByText('Local-first software')).toBeTruthy();
  expect(screen.queryByText('Raindrop review')).toBeNull();
});

test('highlights the matched span in a result title while searching', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // Before searching, the title is a single plain run (no highlighted "software").
  expect(screen.queryByText('software')).toBeNull();

  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'software');

  // The matched span renders as its own run carrying the accent highlight.
  const match = await waitFor(() => screen.getByText('software'));
  expect(match.props.style.backgroundColor).toBeTruthy();
});

test('a punctuation-only query is not a search (keeps the normal Inbox section)', async () => {
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
  await waitFor(() => expect(screen.getByText('Recently saved')).toBeTruthy());

  // A query that normalizes to zero search tokens must NOT flip to the search
  // (Matches/results) section, and must not filter the library down.
  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), '...');

  await waitFor(() => expect(screen.getByText('Recently saved')).toBeTruthy());
  // Stays on the normal "Recently saved" section (not a results header) and the
  // zero-result recovery card must NOT appear — it's not a search at all.
  expect(screen.queryByText(/result/)).toBeNull();
  expect(screen.queryByTestId('inbox-empty-search')).toBeNull();
  // The library is not filtered down.
  expect(screen.getByText('Local-first software')).toBeTruthy();
  expect(screen.getByText('Raindrop review')).toBeTruthy();
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

  await fireEvent.press(screen.getByText('Inbox'));
  expect(screen.getByText('Loose link')).toBeTruthy();
  expect(screen.queryByText('Work doc')).toBeNull();
});

test('facet chips carry icons that distinguish collections from tags (#142)', async () => {
  // The "Inbox" (no-collection) chip used to sit unmarked among bare collection-name
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

test('container chips show a bookmark count (folders + Inbox), tags do not', async () => {
  // The "container" facets — folders and the Inbox (no-collection) set — carry a
  // count so their weight is visible at a glance; #tag chips stay countless (the
  // tag cloud is their frequency view). Two bookmarks in Work, one uncollected.
  const a = '7e64cf1e-0000-4000-8000-0000000000c1';
  const b = '7e64cf1e-0000-4000-8000-0000000000c2';
  const loose = '7e64cf1e-0000-4000-8000-0000000000c3';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: a, title: 'Work A', collection_id: 'col-work' }),
      makeStoredBookmark({ id: b, title: 'Work B', collection_id: 'col-work' }),
      makeStoredBookmark({ id: loose, title: 'Loose note', collection_id: null }),
    ],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        { bookmark_id: a, tag_id: 't-design', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Work A')).toBeTruthy());

  const shelf = screen.getByTestId('browse-shelf');
  // Work folder holds 2, the Inbox set holds 1 — exactly two count tokens.
  expect(within(shelf).getByText('· 2')).toBeTruthy();
  expect(within(shelf).getByText('· 1')).toBeTruthy();
  expect(within(shelf).queryAllByText(/^· /)).toHaveLength(2);
  // The tag chip is present but carries no count.
  expect(within(shelf).getByText('#design')).toBeTruthy();
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

test('an empty library shows the onboarding card even with a legacy Tag-cloud preference', async () => {
  // The tag cloud is no longer a persisted layout: a legacy stored 'cloud'
  // degrades to Cards (parseViewMode), and the cloud is a transient toggle that
  // never cold-starts. On an empty library the Browse-by-tag toggle is hidden
  // and the cloud can't open, so the screen must show the onboarding card.
  fakeRepo.__reset([]);
  await fakeRepo.repository.setMeta(INBOX_VIEW_PREF_KEY, 'cloud');

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull();
  // The toggle is hidden when the library is empty.
  expect(screen.queryByTestId('inbox-browse-tags-toggle')).toBeNull();
});

test('a routed tag facet shows the bookmarks, not the tag cloud', async () => {
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
  // A legacy stored 'cloud' degrades to Cards; the routed facet keeps the cloud
  // closed regardless.
  await fakeRepo.repository.setMeta(INBOX_VIEW_PREF_KEY, 'cloud');

  const screen = await renderInbox();

  // A routed tag facet shows the linked-to bookmark in the item layout, never
  // the global cloud overview.
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

  // Open the Browse-by-tag cloud: both tags appear, cards are gone.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
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
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy();
  expect(screen.getByLabelText('#cooking, 1 bookmark')).toBeTruthy();

  // … picking the Work folder chip narrows the cloud to that folder's tags.
  await fireEvent.press(screen.getByText('Work'));
  await waitFor(() => expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy());
  expect(screen.queryByLabelText('#cooking, 1 bookmark')).toBeNull();
});

test('a search narrows the tag cloud to the tags on matching results', async () => {
  const work = '7e64cf1e-0000-4000-8000-000000000081';
  const home = '7e64cf1e-0000-4000-8000-000000000082';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: work, title: 'Local-first software' }),
      makeStoredBookmark({ id: home, title: 'Kimchi jjigae' }),
    ],
    {
      tags: [makeTag('t-reading', 'reading'), makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        { bookmark_id: work, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
        { bookmark_id: home, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // The whole-Inbox cloud shows both bookmarks' tags …
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  expect(screen.getByLabelText('#reading, 1 bookmark')).toBeTruthy();
  expect(screen.getByLabelText('#cooking, 1 bookmark')).toBeTruthy();

  // … searching narrows it to only the tags carried by the matching result
  // (debounced, so the cloud settles a beat later).
  await fireEvent.changeText(
    screen.getByPlaceholderText('Search titles, tags, folders'),
    'kimchi',
  );
  await waitFor(() => expect(screen.queryByLabelText('#reading, 1 bookmark')).toBeNull());
  expect(screen.getByLabelText('#cooking, 1 bookmark')).toBeTruthy();
});

test('a browse-shelf chip still filters after drilling in from the tag cloud', async () => {
  // Regression for "after selecting a tag from the cloud, the browse chips went
  // dead for several seconds": the shelf chips are now memoized and driven by a
  // stable handler, so this guards that the wiring still responds to a tap right
  // after the cloud→cards drill-in.
  const cooked = '7e64cf1e-0000-4000-8000-000000000091';
  const reading = '7e64cf1e-0000-4000-8000-000000000092';
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

  // Open the cloud and drill into the cooking tag → only that bookmark shows.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
  await waitFor(() => expect(screen.getByText('#cooking · 1')).toBeTruthy());
  expect(screen.queryByText('Local-first software')).toBeNull();

  // Tapping the "All" browse chip immediately responds and clears the facet.
  await fireEvent.press(screen.getByText('All'));
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
  expect(screen.getByText('Kimchi jjigae')).toBeTruthy();
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
    await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
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

test('drilling into a cloud tag does not persist a Cards/List view preference', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000c1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000c2';
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
  // The user's saved item layout is List.
  await fakeRepo.repository.setMeta(INBOX_VIEW_PREF_KEY, 'list');

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getAllByTestId('inbox-list-title').length).toBeGreaterThan(0));

  // Open the transient cloud, then drill into a tag — the cloud is a navigation
  // surface, not a layout, so neither opening it nor drilling in writes a pref.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
  await waitFor(() => expect(screen.getByText('#cooking · 1')).toBeTruthy());

  // The stored layout preference is untouched (still List), so the next launch
  // returns to List — the cloud never persists.
  await waitFor(async () =>
    expect(await fakeRepo.repository.getMeta(INBOX_VIEW_PREF_KEY)).toBe('list'),
  );
});

test('the active-filter bar clears the facet back to all bookmarks', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000d1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000d2';
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

  // Pick the #cooking facet chip: the list narrows and the cooking-less
  // bookmark drops out.
  await fireEvent.press(screen.getByRole('button', { name: '#cooking' }));
  await waitFor(() => expect(screen.queryByText('Local-first software')).toBeNull());

  // The sticky filter bar appears; pressing its clear action restores All.
  expect(screen.getByTestId('inbox-filter-bar')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('inbox-filter-clear'));
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
});

test('the filter bar returns to the tag cloud on any platform', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000e1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000e2';
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

  // Open the cloud and drill into a tag (Platform default — no android override,
  // so this exercises the cross-platform filter bar, not hardware Back).
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
  await waitFor(() => expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull());

  // The bar's back-to-cloud action returns to the cloud overview.
  await fireEvent.press(screen.getByTestId('inbox-filter-back-to-cloud'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
});

test('drilling into a cloud tag lands in the List layout when List is preferred', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000f1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000f2';
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

  // The user deliberately chooses List, then opens the cloud.
  await fireEvent.press(screen.getByTestId('inbox-view-list'));
  await waitFor(() => expect(screen.getAllByTestId('inbox-list-title').length).toBeGreaterThan(0));
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());

  // Drilling in lands back in the current List layout, not hard-coded Cards.
  // Only the #cooking bookmark survives the filter, so a single list row shows.
  await fireEvent.press(await screen.findByLabelText('#cooking, 1 bookmark'));
  await waitFor(() => expect(screen.getByTestId('inbox-list-title')).toBeTruthy());
  expect(screen.queryByTestId('inbox-card-title')).toBeNull();
});

test('the layout segment offers only Cards and List (no Tag-cloud option)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000a1', title: 'Kimchi jjigae' }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());

  // The segment renders exactly the two item layouts; the cloud moved to its
  // own Browse-by-tag toggle.
  expect(screen.getByTestId('inbox-view-card')).toBeTruthy();
  expect(screen.getByTestId('inbox-view-list')).toBeTruthy();
  expect(screen.queryByTestId('inbox-view-cloud')).toBeNull();
  expect(screen.getByTestId('inbox-browse-tags-toggle')).toBeTruthy();
});

test('the Browse-by-tag toggle opens and closes the transient cloud', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000b1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: cooked, title: 'Kimchi jjigae' })],
    {
      tags: [makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        { bookmark_id: cooked, tag_id: 't-cooking', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());

  // Tap once → cloud opens, item layout hidden.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  expect(screen.queryByTestId('inbox-card-title')).toBeNull();

  // Tap again → cloud closes, items return. No filter was applied.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull());
  expect(screen.getByText('Kimchi jjigae')).toBeTruthy();
});

test('closing the Browse-by-tag toggle leaves the active filter unchanged', async () => {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000b2';
  const reading = '7e64cf1e-0000-4000-8000-0000000000b3';
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

  // Narrow to the #cooking facet first.
  await fireEvent.press(screen.getByRole('button', { name: '#cooking' }));
  await waitFor(() => expect(screen.queryByText('Local-first software')).toBeNull());

  // Open the cloud, then close it again via the toggle.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.getByTestId('inbox-tag-cloud')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  await waitFor(() => expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull());

  // The facet is still applied — toggling the cloud never touches the filter.
  expect(screen.getByText('Kimchi jjigae')).toBeTruthy();
  expect(screen.queryByText('Local-first software')).toBeNull();
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

test('the visible ⋯ overflow button opens the action menu (no long-press needed)', async () => {
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

  // Tapping the always-visible ⋯ surfaces the same actions as a long-press,
  // so the move/share/trash menu is discoverable without a hidden gesture.
  await fireEvent.press(screen.getByLabelText('More actions'));
  expect(screen.getByText('Move to collection…')).toBeTruthy();
  expect(screen.getByText('Move to Trash')).toBeTruthy();
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

  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'zzz');

  await waitFor(() => expect(screen.getByText('No bookmarks match your search.')).toBeTruthy());
  // The recovery card stands alone — the "0 results" section label is suppressed
  // so the screen doesn't double-label a zero-result search.
  expect(screen.queryByText('0 results')).toBeNull();
});

test('a search result that matched on its site name shows a distinct site chip', async () => {
  // The bookmark's title/url don't contain "wired" — only its generated
  // site_name does. Before B1 the card never rendered site_name, so this
  // matched result looked like a buggy/random hit. In search mode it now shows
  // a site chip explaining the match.
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-0000000000a1',
      title: 'The future of work',
      url: 'https://example.com/article/12345',
      url_hash: 'https://example.com/article/12345',
      site_name: 'WIRED',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-0000000000a2',
      title: 'Unrelated note',
      url: 'https://other.example/post',
      url_hash: 'https://other.example/post',
      site_name: 'Other Blog',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('The future of work')).toBeTruthy());

  // No site chip outside search mode (it would clutter the normal Inbox).
  expect(screen.queryByTestId('inbox-card-site')).toBeNull();

  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'wired');

  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  // The matched result surfaces its site name; the chip carries the generated
  // site value, kept visually distinct from user-authored chips.
  expect(screen.getByTestId('inbox-card-site')).toBeTruthy();
  expect(screen.getByText('🌐 WIRED')).toBeTruthy();
});

test('a 4th+ tag that matched the query is promoted into the shown tag chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000a3';
  // The matching tag ("kubernetes") sorts last alphabetically and is the 4th
  // tag, so without promotion the card's first-3 slice would hide it and the
  // result would look unexplained.
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Ops runbook' })],
    {
      tags: [
        makeTag('t-alpha', 'alpha'),
        makeTag('t-beta', 'beta'),
        makeTag('t-gamma', 'gamma'),
        makeTag('t-k8s', 'kubernetes'),
      ],
      bookmarkTags: ['t-alpha', 't-beta', 't-gamma', 't-k8s'].map((tagId) => ({
        bookmark_id: id,
        tag_id: tagId,
        source: 'user' as const,
        confidence: null,
        created_at: '2026-06-12T00:00:00.000Z',
      })),
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Ops runbook')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'kubernetes');

  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  // The matched tag is promoted into the card's (max 3) shown meta chips — the
  // card meta chip uses accentText, distinguishing it from the browse-shelf
  // facet chip that also carries "#kubernetes". Without promotion the
  // alphabetical first-3 (alpha/beta/gamma) would hide it.
  const k8sChips = screen.getAllByText('#kubernetes');
  expect(k8sChips.length).toBeGreaterThanOrEqual(2);
});

test('the debounced query does not filter until typing settles', async () => {
  jest.useFakeTimers();
  try {
    fakeRepo.__reset([
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-0000000000b1',
        title: 'Local-first software',
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-0000000000b2',
        title: 'Raindrop review',
      }),
    ]);

    const screen = await renderInbox();
    // Drain the store's async load under fake timers.
    await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText('Search titles, tags, folders'),
        'local-first',
      );
    });

    // Immediately after typing (before the debounce elapses) the list is still
    // unfiltered — both bookmarks remain and there's no "Matches" label yet.
    expect(screen.getByText('Raindrop review')).toBeTruthy();
    expect(screen.queryByText(/^Matches/)).toBeNull();

    // Advance past the debounce window → the derived query settles and filters.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.getByText('1 result')).toBeTruthy();
    expect(screen.queryByText('Raindrop review')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('the empty-search state offers a clear control and a searchable-fields hint', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  const input = screen.getByPlaceholderText('Search titles, tags, folders');
  await fireEvent.changeText(input, 'zzz');

  await waitFor(() => expect(screen.getByTestId('inbox-empty-search')).toBeTruthy());
  // The hint tells the user the search reaches beyond titles …
  expect(screen.getByText('Search also looks in tags, folders, and site names.')).toBeTruthy();

  // … and the visible Clear control resets the query, returning to the full list.
  await fireEvent.press(screen.getByLabelText('Clear search'));
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());
  expect(screen.queryByTestId('inbox-empty-search')).toBeNull();
  expect(input.props.value).toBe('');
});
