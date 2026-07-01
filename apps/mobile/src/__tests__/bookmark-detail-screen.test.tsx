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
const mockDismissTo = jest.fn();
// The detail screen reads the bookmark id from the route; tests set it.
let mockRouteId = 'bookmark-raindrop';
jest.mock('expo-router', () => ({
  useRouter: () => ({
    navigate: mockNavigate,
    dismissTo: mockDismissTo,
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  }),
  useLocalSearchParams: () => ({ id: mockRouteId }),
}));

import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderDetail() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <BookmarkDetailScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

test('tapping a tag chip navigates to the Inbox filtered by that tag', async () => {
  mockRouteId = 'bookmark-raindrop';
  // Seed a real tag + link for this bookmark (the app no longer ships sample data).
  fakeRepo.__reset(
    [makeStoredBookmark({ id: 'bookmark-raindrop', title: 'Raindrop review' })],
    {
      tags: [
        {
          id: 'tag-design',
          user_id: 'user-test',
          name: 'design',
          slug: 'design',
          source: 'user',
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      bookmarkTags: [
        {
          bookmark_id: 'bookmark-raindrop',
          tag_id: 'tag-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [],
    },
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Browse #design'));

  expect(mockDismissTo).toHaveBeenCalledTimes(1);
  const [arg] = mockDismissTo.mock.calls[0];
  expect(arg.pathname).toBe('/');
  expect(arg.params.tag).toBe('tag-design');
  // A nonce rides along so re-browsing the same tag re-applies past the Inbox's
  // (tag + t) dedupe even after the user cleared the facet.
  expect(arg.params.t).toBeTruthy();
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

test('a stale enrichment shows an out-of-date hint (when there are suggestions to be stale against)', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A url from example.com.',
        status: 'stale',
        // The stale hint explains why the suggestions look out of date, so it
        // only makes sense when there ARE suggestions on screen.
        suggested_tags: [{ name: 'design', confidence: 0.8 }],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText(/Edited since these suggestions/)).toBeTruthy();
});

test('a dummy-v0 fallback with nothing to suggest collapses to just the affordance', async () => {
  mockRouteId = SYNCED_ID;
  // The exact case the user flagged: AI couldn't be reached, dummy-v0 produced
  // no tags and no folder, yet the row still carries a boilerplate summary and a
  // degraded note. All of it is noise — silence it, but never the way to retry.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'Url from share.google — “○○”. Auto-categorized by dummy-v0.',
        model: 'dummy-v0',
        degraded: true,
        degraded_reason: 'provider_error',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.queryByText(/Auto-categorized by dummy-v0/)).toBeNull();
  expect(screen.queryByText(/reach AI/)).toBeNull();
  expect(screen.queryByText('dummy-v0')).toBeNull();
  // The affordance to ask for AI never disappears (capture stays reachable).
  expect(screen.getByText('Refresh AI suggestions')).toBeTruthy();
});

test('a healthy dummy-v0 result with no suggestions still hides its boilerplate summary', async () => {
  mockRouteId = SYNCED_ID;
  // Not degraded, but dummy-v0 matched nothing — the generic "Url from …" line is
  // just as meaningless, so it stays silenced.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'Url from share.google — “○○”. Auto-categorized by dummy-v0.',
        model: 'dummy-v0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.queryByText(/Auto-categorized by dummy-v0/)).toBeNull();
  expect(screen.queryByText('dummy-v0')).toBeNull();
  expect(screen.getByText('Refresh AI suggestions')).toBeTruthy();
});

test('a real-model summary is kept even with no tags to suggest', async () => {
  mockRouteId = SYNCED_ID;
  // A genuine model summary is real content — only the dummy-v0 boilerplate is
  // noise, so a non-dummy summary shows (with its badge) even when tags are empty.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        summary: 'A thoughtful overview of local-first software.',
        model: 'gemini-2.0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  expect(screen.getByText('A thoughtful overview of local-first software.')).toBeTruthy();
  expect(screen.getByText('gemini-2.0')).toBeTruthy();
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

  expect(screen.getByText(/AI is over capacity right now — showing basic suggestions/)).toBeTruthy();
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

test('add all also files into the suggested folder, not just the tags', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_collection_id: 'col-recipes',
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

  // Tags become real, and the folder is filed in — its chip disappears.
  await waitFor(() => expect(screen.getByLabelText('Browse #design')).toBeTruthy());
  expect(screen.getByLabelText('Browse #video')).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull(),
  );
});

test('dismiss all also dismisses the suggested folder, not just the tags', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_collection_id: 'col-recipes',
        suggested_tags: [
          { name: 'design', confidence: 0.8 },
          { name: 'video', confidence: 0.6 },
        ],
      }),
    ],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('Dismiss all suggestions')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions'));

  // Both the tag suggestions and the folder chip are gone.
  expect(screen.queryByLabelText('Accept suggested tag design')).toBeNull();
  await waitFor(() =>
    expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull(),
  );
});

test('the bulk row shows for a folder plus a single tag suggestion', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [
      makeEnrichment({
        bookmark_id: SYNCED_ID,
        suggested_collection_id: 'col-recipes',
        suggested_tags: [{ name: 'design', confidence: 0.8 }],
      }),
    ],
  );

  const screen = await renderDetail();
  // One tag alone wouldn't reach the >1 threshold; the folder makes it two
  // actionable suggestions, so "Add all"/"Dismiss all" appear.
  await waitFor(() => expect(screen.getByLabelText('Add all suggestions')).toBeTruthy());
  expect(screen.getByLabelText('Dismiss all suggestions')).toBeTruthy();
});

test('shows the suggested folder as a chip beside the picker and files into it', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Recipes')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('File A synced bookmark into Recipes'));

  // Once filed in, the suggestion (a different folder than current) is gone.
  await waitFor(() => expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull());

  // Accepting also records the decision durably (mirrors an accepted tag), so the
  // recommendation can't re-surface if the bookmark later moves out of the folder
  // — the regression was that accept relied solely on "already lives there".
  await waitFor(() =>
    expect(fakeRepo.__meta('dismissed_folder_suggestions')).toContain('id:col-recipes'),
  );
});

test('the suggested folder chip can be dismissed', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Recipes')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull();
});

test('dismissing a folder suggestion persists it durably (gone on re-entry)', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Recipes')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  // The dismissal is written to durable meta (keyed by a stable token), so a
  // later re-entry re-hydrates it and the chip stays gone — the regression was
  // that it lived only in session state and re-appeared on re-open.
  await waitFor(() =>
    expect(fakeRepo.__meta('dismissed_folder_suggestions')).toContain('id:col-recipes'),
  );
});

test('a durably-dismissed folder suggestion is hidden on first render', async () => {
  mockRouteId = SYNCED_ID;
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );
  // Simulate a prior session's dismissal already in the durable store.
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [SYNCED_ID]: ['id:col-recipes'] }));

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());
  expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull();
});

test('a dismissed "create" suggestion stays gone once a matching folder appears', async () => {
  mockRouteId = SYNCED_ID;
  // The AI proposed creating "Recipes" and the user dismissed it (name token).
  // A matching "Recipes" collection now exists, so the suggestion would resolve
  // to a "file into" chip — but the name-keyed dismissal must still suppress it.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'Recipes' })],
  );
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [SYNCED_ID]: ['name:recipes'] }));

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());
  // Resolves to "file into Recipes" by name match, but stays hidden by the
  // earlier name-keyed dismissal rather than reappearing.
  expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull();
  expect(screen.queryByLabelText('Create collection Recipes and file A synced bookmark into it')).toBeNull();
});

test('dismissing a name-matched folder chip records both id and name tokens', async () => {
  mockRouteId = SYNCED_ID;
  // The AI proposed "recipes" (no id); a live "Recipes" folder matches by name,
  // so the chip is "file into". Dismissing must persist BOTH tokens so the
  // suggestion stays gone if the folder is later deleted (flips back to "create").
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: null })],
    collectionTagData(),
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_name: 'recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Recipes')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  await waitFor(() => {
    const raw = fakeRepo.__meta('dismissed_folder_suggestions');
    expect(raw).toContain('id:col-recipes');
    expect(raw).toContain('name:recipes');
  });
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
    await waitFor(() => screen.getByLabelText('Create collection Recipes and file A synced bookmark into it')),
  ).toBeTruthy();
  // It's a create suggestion, not a "file into existing" one.
  expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull();
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
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Recipes')).toBeTruthy());
  expect(screen.queryByLabelText('Create collection recipes and file A synced bookmark into it')).toBeNull();

  await fireEvent.press(screen.getByLabelText('File A synced bookmark into Recipes'));
  await waitFor(() => expect(screen.queryByLabelText('File A synced bookmark into Recipes')).toBeNull());
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
  await waitFor(() => expect(screen.getByLabelText('File A synced bookmark into Watch Later')).toBeTruthy());
  expect(screen.queryByLabelText('Create collection watch-later and file A synced bookmark into it')).toBeNull();
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
    expect(screen.getByLabelText('Create collection Recipes and file A synced bookmark into it')).toBeTruthy(),
  );

  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Recipes'));

  expect(screen.queryByLabelText('Create collection Recipes and file A synced bookmark into it')).toBeNull();
});

test('a CHANGE (move) suggestion strikes the current folder and shows the move target', async () => {
  mockRouteId = SYNCED_ID;
  const now = '2026-06-12T00:00:00.000Z';
  // The bookmark already lives in "Watch Later"; the AI suggests "Recipes" — a
  // move, so the chip reads ~~Watch Later~~ → Recipes (current struck, target tinted).
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'A synced bookmark', collection_id: 'col-watch' })],
    {
      tags: [],
      bookmarkTags: [],
      collections: [
        { id: 'col-recipes', user_id: 'user-test', name: 'Recipes', description: null, created_at: now, updated_at: now },
        { id: 'col-watch', user_id: 'user-test', name: 'Watch Later', description: null, created_at: now, updated_at: now },
      ],
    },
    [makeEnrichment({ bookmark_id: SYNCED_ID, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());

  // The from name and the move target render as separate runs (the strikethrough
  // is a real style on the struck run, never literal "~~").
  expect(screen.getByText('Watch Later')).toBeTruthy();
  expect(screen.getByText('→ Recipes')).toBeTruthy();
  // The chip a11y spells the move out for screen readers (can't see the strike).
  expect(
    screen.getByLabelText('Move A synced bookmark from Watch Later to Recipes'),
  ).toBeTruthy();
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
