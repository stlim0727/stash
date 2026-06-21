import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
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
// The detail screen reads the bookmark id from the route; tests set it.
let mockRouteId = 'bookmark-raindrop';
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: mockRouteId }),
}));

import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderDetail() {
  return render(
    <BookmarksProvider>
      <BookmarkDetailScreen />
    </BookmarksProvider>,
  );
}

test('tapping a tag chip navigates to the Inbox filtered by that tag', async () => {
  mockRouteId = 'bookmark-raindrop';
  // The seeded sample "bookmark-raindrop" carries the mock tag "design".
  fakeRepo.__reset([makeStoredBookmark({ id: 'bookmark-raindrop', title: 'Raindrop review' })]);

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Browse #design'));

  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', params: { tag: 'tag-design' } });
});

test('tapping the preview image opens the bookmark link', async () => {
  mockRouteId = SYNCED_ID;
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  fakeRepo.__reset([
    makeStoredBookmark({
      id: SYNCED_ID,
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
      preview_image_url: 'https://example.com/preview.png',
    }),
  ]);

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Open link'));

  expect(openURL).toHaveBeenCalledWith('https://www.inkandswitch.com/local-first/');
  openURL.mockRestore();
});

test('a very long title collapses behind a Show more toggle', async () => {
  mockRouteId = SYNCED_ID;
  const longTitle =
    '여행 크리에이터 도PD on Instagram: "(공유해서 여행 계획 세워보세요) 입소문 나긴함 양양 광나루해변 수심이 다양하고 방파제가 파도를 막아주면서 물놀이하기 좋은 숨겨진 해변이었는데요';
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, title: longTitle })]);

  const screen = await renderDetail();
  const title = await waitFor(() => screen.getByText(longTitle));

  // onTextLayout doesn't fire in the test renderer; simulate a title that
  // wraps to more lines than the collapsed limit so the toggle appears.
  fireEvent(title, 'textLayout', {
    nativeEvent: { lines: new Array(8).fill({ text: '' }) },
  });

  const toggle = await waitFor(() => screen.getByText('Show more'));
  await fireEvent.press(toggle);
  expect(screen.getByText('Show less')).toBeTruthy();
});

test('the title button exposes the title text to screen readers', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, title: 'Local-first software' })]);

  const screen = await renderDetail();

  // The accessible name must be the title itself, not just the edit action,
  // so VoiceOver/TalkBack announce the primary content.
  const titleButton = await waitFor(() => screen.getByLabelText('Local-first software'));
  expect(titleButton).toBeTruthy();
});

test('a title that grows after mount re-measures and shows the toggle', async () => {
  mockRouteId = SYNCED_ID;
  const longTitle =
    'A very long title that only arrives after background metadata enrichment fills it in';
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, title: 'Untitled' })]);

  const screen = await renderDetail();

  // Initial short title measures as a single line — no toggle.
  const initial = await waitFor(() => screen.getByText('Untitled'));
  await fireEvent(initial, 'textLayout', { nativeEvent: { lines: [{ text: '' }] } });
  expect(screen.queryByText('Show more')).toBeNull();

  // Simulate the title changing while the screen stays mounted (edit + commit
  // exercises the same store update that background enrichment would).
  await fireEvent.press(screen.getByText('Untitled'));
  const input = await waitFor(() => screen.getByLabelText('Edit title'));
  await fireEvent.changeText(input, longTitle);
  await fireEvent(input, 'blur');

  // The displayed title is re-measured; now it overflows and offers the toggle.
  const grown = await waitFor(() => screen.getByText(longTitle));
  await fireEvent(grown, 'textLayout', {
    nativeEvent: { lines: new Array(6).fill({ text: '' }) },
  });
  expect(await waitFor(() => screen.getByText('Show more'))).toBeTruthy();
});

test('renders AI suggestions with a model badge, summary, and trigger button', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
        model: 'dummy-v0',
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText('dummy-v0')).toBeTruthy();
  expect(screen.getByText('A url from example.com.')).toBeTruthy();
  expect(screen.getByLabelText('Accept suggested tag design')).toBeTruthy();
  expect(screen.getByLabelText('Accept suggested tag video')).toBeTruthy();
  // Synced bookmark → the on-demand trigger is offered.
  expect(screen.getByText('Refresh AI suggestions')).toBeTruthy();
});

test('a stale enrichment shows an out-of-date hint', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        status: 'stale',
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText(/Edited since these suggestions/)).toBeTruthy();
});

test('a degraded enrichment shows a non-error "basic suggestions" note', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        model: 'dummy-v0',
        degraded: true,
        degraded_reason: 'rate_limited',
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText(/AI is busy — showing basic suggestions/)).toBeTruthy();
});

test('dismissing a suggested tag removes it from the list', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Accept suggested tag design')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss suggested tag design'));

  expect(screen.queryByLabelText('Accept suggested tag design')).toBeNull();
  expect(screen.getByLabelText('Accept suggested tag video')).toBeTruthy();
});

test('dismiss all clears every suggestion at once', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Accept suggested tag design')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions'));

  expect(screen.queryByLabelText('Accept suggested tag design')).toBeNull();
  expect(screen.queryByLabelText('Accept suggested tag video')).toBeNull();
});

test('add all applies every suggested tag at once', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Add all suggestions')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Add all suggestions'));

  // Both suggestions become real, browsable tags and are no longer offered.
  await waitFor(() => expect(screen.getByLabelText('Browse #design')).toBeTruthy());
  expect(screen.getByLabelText('Browse #video')).toBeTruthy();
  expect(screen.queryByLabelText('Accept suggested tag design')).toBeNull();
});

function collectionTagData() {
  return {
    tags: [],
    bookmarkTags: [],
    collections: [
      {
        id: 'col-recipes',
        user_id: 'user-test',
        name: 'Recipes',
        description: null,
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      },
    ],
  };
}

test('shows the suggested folder as a chip beside the picker and files into it', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File into Recipes')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('File into Recipes'));

  // Once filed in, the suggestion (a different folder than current) is gone.
  await waitFor(() => expect(screen.queryByLabelText('File into Recipes')).toBeNull());
});

test('the suggested folder chip can be dismissed', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File into Recipes')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  expect(screen.queryByLabelText('File into Recipes')).toBeNull();
});

test('offers to create a brand-new collection when the AI suggests one that does not exist', async () => {
  mockRouteId = SYNCED_ID;
  // No seeded collections: the enrichment carries only a proposed NAME, so the
  // suggestion is "create it" rather than "file into" an existing folder.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'Recipes' })],
  );

  const screen = await renderDetail();

  expect(
    await waitFor(() => screen.getByLabelText('Create collection Recipes and file into it')),
  ).toBeTruthy();
  // It's a create suggestion, not a "file into existing" one.
  expect(screen.queryByLabelText('File into Recipes')).toBeNull();
});

test('files into an existing collection when the proposed name matches one (id unresolved)', async () => {
  mockRouteId = SYNCED_ID;
  // The proposed name matches a real collection (differing only in case), even
  // though the server left suggested_collection_id null — file in, don't create.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File into Recipes')).toBeTruthy());
  expect(screen.queryByLabelText('Create collection recipes and file into it')).toBeNull();

  await fireEvent.press(screen.getByLabelText('File into Recipes'));
  await waitFor(() => expect(screen.queryByLabelText('File into Recipes')).toBeNull());
});

test('matches a live collection that differs only in spacing/punctuation (no duplicate create)', async () => {
  mockRouteId = SYNCED_ID;
  // Existing folder "Watch Later"; the AI proposed "watch-later" with no id.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    {
      tags: [],
      bookmarkTags: [],
      collections: [
        {
          id: 'col-watch',
          user_id: 'user-test',
          name: 'Watch Later',
          description: null,
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
      ],
    },
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'watch-later' })],
  );

  const screen = await renderDetail();

  // Resolves to the existing folder — file in, never offer to create a duplicate.
  await waitFor(() => expect(screen.getByLabelText('File into Watch Later')).toBeTruthy());
  expect(screen.queryByLabelText('Create collection watch-later and file into it')).toBeNull();
});

test('the create-collection suggestion can be dismissed', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'Recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() =>
    expect(screen.getByLabelText('Create collection Recipes and file into it')).toBeTruthy(),
  );

  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  expect(screen.queryByLabelText('Create collection Recipes and file into it')).toBeNull();
});

test('offers hashtags from the title as one-tap tag suggestions', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset([
    makeStoredBookmark({
      id: SYNCED_ID,
      title: '자취요리신 on Instagram: "SNS에서 난리난 덮밥 #목살 #덮밥"',
    }),
  ]);

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Accept suggested tag 목살')).toBeTruthy());

  expect(screen.getByLabelText('Accept suggested tag 덮밥')).toBeTruthy();

  // Accepting promotes the hashtag to a real, browsable tag chip.
  await fireEvent.press(screen.getByLabelText('Accept suggested tag 목살'));
  await waitFor(() => expect(screen.getByLabelText('Browse #목살')).toBeTruthy());
  // ...and it is no longer offered as a suggestion.
  expect(screen.queryByLabelText('Accept suggested tag 목살')).toBeNull();
});
