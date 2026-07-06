import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
// Drive the responsive card grid off a controllable viewport. Defaults to a
// phone width so every existing test keeps columns === 1 (single column);
// individual tests widen it to exercise the multi-column path.
const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));
let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
const mockSetParams = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({
      push: mockPush,
      navigate: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
      setParams: mockSetParams,
    }),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/',
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
  mockPush.mockClear();
  mockSetParams.mockClear();
  // Reset to a phone-width viewport so a widened test can't leak into others.
  mockWindowSize.width = 390;
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

test('exposes each bookmark row as a button labelled by its title', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();

  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Local-first software' })).toBeTruthy(),
  );
});

test('labels an untitled URL row by hostname, not the raw URL, for screen readers', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000c',
      title: null,
      url: 'https://www.inkandswitch.com/local-first/?ref=newsletter',
      url_hash: 'https://www.inkandswitch.com/local-first/?ref=newsletter',
    }),
  ]);

  const screen = await renderInbox();

  // The friendly a11y label is the bare hostname (www. stripped) — never the
  // full URL VoiceOver would otherwise spell out character by character.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'inkandswitch.com' })).toBeTruthy(),
  );
  expect(
    screen.queryByLabelText('https://www.inkandswitch.com/local-first/?ref=newsletter'),
  ).toBeNull();
});

test('folds the search/sort/view controls away on an empty library', async () => {
  fakeRepo.__reset([]);

  const screen = await renderInbox();

  // Empty first run: the controls are cold chrome over "nothing here yet", so
  // the first screen is all about the first save — an onboarding card that
  // teaches the share-sheet capture, with the chrome folded away.
  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(
    screen.getByText('Share a link from any app and pick Keepory to save it in a tap.'),
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

test('announces unseen arrivals as a "new" review chip, with no acknowledge ✕', async () => {
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

  // The Review entry point is the first chip on the browse shelf (it used to be
  // a full-width banner); unseen arrivals put it in its accent "new" state.
  await waitFor(() => screen.getByTestId('review-chip'));
  expect(screen.getByText('✨ 1 new AI suggestion')).toBeTruthy();
  // While the alert announces, the per-card ✨ badge is suppressed so the same
  // item isn't shouted twice on one screen.
  expect(screen.queryByLabelText('1 AI suggestion')).toBeNull();
  // There is no acknowledge ✕ anymore — visiting Review is the acknowledgment
  // (review.tsx clears the unseen set on focus).
  expect(screen.queryByLabelText('Dismiss new AI suggestions')).toBeNull();
});

test('shows a persistent review banner for pending suggestions even with nothing unseen', async () => {
  const id = '7e64cf1e-0000-4000-8000-00000000001d';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Foreground save' })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.8 }] })],
  );
  // No unseen marker — the suggestion was seen as it was saved. The banner is
  // the standing entry point into Review, so it still shows (calm form), and the
  // per-card ✨ badge shows alongside it as the per-item cue.

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Foreground save')).toBeTruthy());
  expect(screen.getByTestId('review-chip')).toBeTruthy();
  expect(screen.getByText('✨ 1 suggestion to review')).toBeTruthy();
  // Not the "new" alert, and no acknowledge ✕ in the calm state.
  expect(screen.queryByText('✨ 1 new AI suggestion')).toBeNull();
  expect(screen.queryByLabelText('Dismiss new AI suggestions')).toBeNull();
  expect(screen.getByLabelText('1 AI suggestion')).toBeTruthy();
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

  await waitFor(() => expect(screen.getByTestId('review-chip')).toBeTruthy());
  expect(screen.getByText('✨ 1 new AI suggestion')).toBeTruthy();
});

test('the per-card ✨ badge counts a folder-only recommendation (no tags)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000f1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder only', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [], suggested_collection_name: 'Travel' })],
  );
  // No unseen marker, so the banner is in its calm standing form and the
  // per-card badge shows alongside it as the per-item cue.

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Folder only')).toBeTruthy());
  // The folder counts toward the badge even with zero pending tags — matching the
  // banner/Review inclusion rule (regression: the badge ignored folders).
  expect(screen.getByLabelText('1 AI suggestion')).toBeTruthy();
  // ...and the same folder-only item counts toward the persistent review banner.
  expect(screen.getByTestId('review-chip')).toBeTruthy();
  expect(screen.getByText('✨ 1 suggestion to review')).toBeTruthy();
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
  // No pending tag and the folder is dismissed → nothing to badge, and the
  // persistent review banner honors that durable dismissal (stays down).
  expect(screen.queryByLabelText('1 AI suggestion')).toBeNull();
  expect(screen.queryByTestId('review-chip')).toBeNull();
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
  expect(screen.queryByTestId('review-chip')).toBeNull();
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
  expect(screen.queryByTestId('review-chip')).toBeNull();
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

  // Search is tap-to-open now: reveal the field before typing.
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'local-first');

  // The derived query is debounced, so the count/filter settle a beat later.
  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  expect(screen.getByText('Local-first software')).toBeTruthy();
  expect(screen.queryByText('Raindrop review')).toBeNull();
});

test('slims the header while searching: the sort row and browse shelf fold away', async () => {
  // "Search results, keyboard down" (searching, field blurred): the sort-controls
  // row and the browse shelf hide so the results ribbon rises under the input.
  // fireEvent.changeText doesn't focus the field, so this is exactly that state.
  const a = '7e64cf1e-0000-4000-8000-0000000000d1';
  const b = '7e64cf1e-0000-4000-8000-0000000000d2';
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: a,
        title: 'Local-first software',
        url: 'https://www.inkandswitch.com/local-first/',
        url_hash: 'https://www.inkandswitch.com/local-first/',
        collection_id: 'col-work',
      }),
      makeStoredBookmark({ id: b, title: 'Raindrop review', collection_id: null }),
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
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  // Before searching, the sort pill and browse shelf are present.
  expect(screen.getByText('Newest')).toBeTruthy();
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();

  // Open search (tap-to-open), type, then blur to reach the "results, keyboard
  // down" slim state (searching + field blurred).
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  const searchInput = screen.getByPlaceholderText('Search titles, tags, folders');
  await fireEvent.changeText(searchInput, 'local-first');
  await fireEvent(searchInput, 'blur');
  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());

  // Slimmed: the sort row and the browse shelf are gone — but the input stays and
  // the persistent results ribbon (with its clear ✕) remains under it.
  expect(screen.queryByText('Newest')).toBeNull();
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
  expect(screen.getByTestId('inbox-search-input')).toBeTruthy();
  expect(screen.getByTestId('inbox-filter-bar')).toBeTruthy();

  // Clearing the search restores the sort row and the browse shelf.
  await fireEvent.press(screen.getByTestId('inbox-filter-clear'));
  await waitFor(() => expect(screen.getByText('Newest')).toBeTruthy());
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();
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

  await fireEvent.press(screen.getByTestId('inbox-search-open'));
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
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
  // The normal Inbox no longer carries a "Recently saved" section header — it
  // was redundant chrome and now shows only for real searches. Verify the
  // non-search state by its content, not a label.
  expect(screen.queryByText('Recently saved')).toBeNull();

  // A query that normalizes to zero search tokens must NOT flip to the search
  // (Matches/results) section, and must not filter the library down.
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), '...');

  // Stays on the normal Inbox (no results header, no section label) and the
  // zero-result recovery card must NOT appear — it's not a search at all.
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());
  expect(screen.queryByText('Recently saved')).toBeNull();
  expect(screen.queryByText(/result/)).toBeNull();
  expect(screen.queryByTestId('inbox-empty-search')).toBeNull();
  // The library is not filtered down.
  expect(screen.getByText('Local-first software')).toBeTruthy();
});

test('search is tap-to-open: the field is hidden until the magnifier is pressed', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-0000000000c1',
        title: 'Work doc',
        collection_id: 'col-work',
      }),
    ],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Work doc')).toBeTruthy());

  // At rest the search field is NOT mounted — only the magnifier, alongside the
  // sort row and the browse shelf (the thin resting top).
  expect(screen.queryByTestId('inbox-search-input')).toBeNull();
  expect(screen.getByTestId('inbox-search-open')).toBeTruthy();
  expect(screen.getByText('Newest')).toBeTruthy();
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();

  // Tapping the magnifier reveals the field and folds the sort row + shelf away.
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  await waitFor(() => expect(screen.getByTestId('inbox-search-input')).toBeTruthy());
  expect(screen.queryByText('Newest')).toBeNull();
  expect(screen.queryByTestId('browse-shelf')).toBeNull();

  // Tapping it again (now the ✕) with an empty query closes search: the field
  // unmounts and the sort row + browse shelf return.
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  await waitFor(() => expect(screen.queryByTestId('inbox-search-input')).toBeNull());
  expect(screen.getByText('Newest')).toBeTruthy();
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();
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
  // The active facet is named by the pinned filter bar (the section label no
  // longer duplicates the scope outside of search).
  expect(screen.getByText('Filtered: #design')).toBeTruthy();
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

  // Selecting Compact renders the same bookmark as a compact row (its own title
  // testID), distinct from both the card and the dense list.
  await fireEvent.press(screen.getByTestId('inbox-view-compact'));
  await waitFor(() => expect(screen.getByTestId('inbox-compact-title')).toBeTruthy());
  expect(screen.queryByTestId('inbox-card-title')).toBeNull();
  expect(screen.queryByTestId('inbox-list-title')).toBeNull();
  expect(screen.getByText('Local-first software')).toBeTruthy();

  // Selecting Cards again returns to the card layout.
  await fireEvent.press(screen.getByTestId('inbox-view-card'));
  await waitFor(() => expect(screen.getByTestId('inbox-card-title')).toBeTruthy());
  expect(screen.queryByTestId('inbox-list-title')).toBeNull();
  expect(screen.queryByTestId('inbox-compact-title')).toBeNull();
});

test('the Browse-by-tag toggle navigates to the dedicated tag-browse route', async () => {
  // The transient in-Inbox cloud was replaced by a dedicated /browse/tags route;
  // the toggle now navigates there instead of flipping an in-screen surface.
  const cooked = '7e64cf1e-0000-4000-8000-000000000061';
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

  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));

  // It pushes the route (no in-screen cloud surface exists anymore).
  expect(mockPush).toHaveBeenCalledWith('/browse/tags');
  expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull();
  expect(screen.queryByTestId('inbox-cloud-tag')).toBeNull();
});

test('the Browse-by-tag toggle carries the active folder facet as the route scope', async () => {
  const work = '7e64cf1e-0000-4000-8000-000000000071';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: work, title: 'Local-first software', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-reading', 'reading')],
      bookmarkTags: [
        { bookmark_id: work, tag_id: 't-reading', source: 'user', confidence: null, created_at: '2026-06-12T00:00:00.000Z' },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // Narrow to the Work folder first, then open the tag-browse route: the active
  // facet rides along as the scope param.
  await fireEvent.press(screen.getByText('Work'));
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));

  expect(mockPush).toHaveBeenCalledWith('/browse/tags?scope=collection:col-work');
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

  // STASH-T: clearing must also strip the URL-backed facet params, or a web
  // reload (F5) re-applies the "cleared" facet from the stale query string.
  expect(mockSetParams).toHaveBeenCalledWith({
    tag: undefined,
    collection: undefined,
    t: undefined,
  });
});

test('selecting the All chip also strips the URL facet params (STASH-T, all reset paths)', async () => {
  // The scope-bar X is not the only reset path: the visible browse shelf's
  // "All" chip clears a URL-backed facet too. It must strip the params just the
  // same, or a web reload re-applies the deep-linked facet the user cleared.
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
  // Arrive deep-linked to the #cooking facet via the URL (as /browse/tags does).
  mockParams = { tag: 't-cooking', t: '1' };

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());
  await waitFor(() => expect(screen.queryByText('Local-first software')).toBeNull());

  mockSetParams.mockClear();
  // Tap the shelf's "All" chip: the filter resets AND the stale ?tag= param
  // must be stripped so an F5 doesn't resurrect #cooking.
  await fireEvent.press(screen.getByRole('button', { name: 'All' }));
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
  expect(mockSetParams).toHaveBeenCalledWith({
    tag: undefined,
    collection: undefined,
    t: undefined,
  });
});

test('the layout segment offers Cards, Compact and List (no Tag-cloud option)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000a1', title: 'Kimchi jjigae' }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Kimchi jjigae')).toBeTruthy());

  // The segment renders exactly the three item layouts; the cloud moved to its
  // own Browse-by-tag toggle.
  expect(screen.getByTestId('inbox-view-card')).toBeTruthy();
  expect(screen.getByTestId('inbox-view-compact')).toBeTruthy();
  expect(screen.getByTestId('inbox-view-list')).toBeTruthy();
  expect(screen.queryByTestId('inbox-view-cloud')).toBeNull();
  const browseToggle = screen.getByTestId('inbox-browse-tags-toggle');
  expect(browseToggle).toBeTruthy();
  // De-pilled to icon-only: the a11y label must be self-contained since there's
  // no visible text label anymore.
  expect(screen.getByLabelText('Browse by tag')).toBe(browseToggle);
});

test('opening the Browse-by-tag route does not change the Inbox filter', async () => {
  // The toggle now navigates instead of flipping an in-screen surface, so it
  // must not touch the active facet (no in-Inbox cloud machinery remains).
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

  // Pressing the toggle navigates and leaves the Inbox's own filter exactly as
  // it was — there's no in-screen cloud to open/close. A tag facet has no
  // browse-tags scope (the route scopes by collection/uncollected only), so the
  // route opens unscoped while the Inbox keeps its #cooking facet underneath.
  await fireEvent.press(screen.getByTestId('inbox-browse-tags-toggle'));
  expect(mockPush).toHaveBeenCalledWith('/browse/tags');
  expect(screen.queryByTestId('inbox-tag-cloud')).toBeNull();
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

  await fireEvent.press(screen.getByTestId('inbox-search-open'));
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

  await fireEvent.press(screen.getByTestId('inbox-search-open'));
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

  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  await fireEvent.changeText(screen.getByPlaceholderText('Search titles, tags, folders'), 'kubernetes');

  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  // The matched tag is promoted into the card's (max 3) shown meta chips. While
  // searching the header slims (the browse shelf, which also carries a
  // "#kubernetes" facet chip, is folded away), so the ONLY "#kubernetes" left is
  // the promoted card meta chip — present despite sorting 4th alphabetically,
  // where the first-3 slice (alpha/beta/gamma) would otherwise hide it.
  const k8sChips = screen.getAllByText('#kubernetes');
  expect(k8sChips.length).toBe(1);
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

    await fireEvent.press(screen.getByTestId('inbox-search-open'));
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

  await fireEvent.press(screen.getByTestId('inbox-search-open'));
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

test('a wide viewport flows the card layout into multiple columns', async () => {
  // A desktop-web-width window: the card grid widens from the single fixed
  // column to columns = min(3, floor(width / 380)). At 1280 that's 3.
  mockWindowSize.width = 1280;
  // Four cards in a 3-column grid → the final row is padded up to a multiple of
  // 3 (6 cells) with two filler placeholders so the real cards keep their column
  // width. numColumns is a composite FlatList prop RNTL v14 can't query on a host
  // element, so we assert its observable consequence: the placeholder padding
  // count uniquely pins the column count (4 cards, 2 fillers → 3 columns).
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e1', title: 'Card one' }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e2', title: 'Card two' }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e3', title: 'Card three' }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000e4', title: 'Card four' }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Card one')).toBeTruthy());

  expect(screen.getAllByTestId('inbox-grid-filler')).toHaveLength(2);
});

test('a phone-width viewport keeps the card layout single-column (no grid padding)', async () => {
  // The default phone width (390) yields floor(390 / 380) = 1 → single column,
  // so no placeholder padding is added and the native path is unchanged.
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f1', title: 'Card one' }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f2', title: 'Card two' }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Card one')).toBeTruthy());

  expect(screen.queryByTestId('inbox-grid-filler')).toBeNull();
});
