import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// `mock`-prefixed so jest's hoisted factory may close over it.
const mockRouterPush = jest.fn();

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
  useRouter: () => ({ push: mockRouterPush, navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

import ReviewScreen from '@/app/review';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderReview() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <ReviewScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockRouterPush.mockClear();
});

test('lists bookmarks with pending high-confidence suggestions and their chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000a1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'A bookmark to review' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.7 },
          // Below the 0.6 threshold — must not appear.
          { name: 'noise', confidence: 0.3 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('A bookmark to review')).toBeTruthy());
  expect(screen.getByText('#design')).toBeTruthy();
  expect(screen.getByText('#video')).toBeTruthy();
  expect(screen.queryByText('#noise')).toBeNull();
  // Two suggestions -> an "Accept all" affordance.
  expect(screen.getByText('Accept all')).toBeTruthy();
});

test('shows the empty state when nothing is pending', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Plain bookmark' })]);

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('No suggestions to review.')).toBeTruthy());
});

test('tapping the card title navigates to the bookmark detail', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Open me' })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.9 }] })],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Open me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Go to Open me'));

  expect(mockRouterPush).toHaveBeenCalledWith({ pathname: '/bookmark/[id]', params: { id } });
});

test('"Dismiss all" clears the card without applying any tags', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Dismiss me' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.8 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Dismiss me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions for Dismiss me'));

  // The card drops out, and dismissing applies no tags (the chips just vanish).
  await waitFor(() => expect(screen.queryByText('Dismiss me')).toBeNull());
  expect(screen.queryByText('#design')).toBeNull();
});

test('surfaces a folder recommendation (📁 ＋) alongside tags (#) and files in on tap', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c1';
  const now = '2026-06-12T00:00:00.000Z';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Recipe page', collection_id: null })],
    {
      tags: [],
      bookmarkTags: [],
      collections: [
        { id: 'col-recipes', user_id: 'user-test', name: 'Recipes', description: null, created_at: now, updated_at: now },
      ],
    },
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_collection_id: 'col-recipes',
        suggested_tags: [{ name: 'cooking', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Recipe page')).toBeTruthy());
  // An ADD (the bookmark has no collection) reads "📁 → {name}"; the tag gets #.
  expect(screen.getByText('📁 → Recipes')).toBeTruthy();
  expect(screen.getByText('#cooking')).toBeTruthy();

  // Filing into the folder makes the recommendation stop surfacing; with no
  // other pending folder suggestion the chip drops out (the tag remains).
  await fireEvent.press(screen.getByLabelText('File Recipe page into Recipes'));
  await waitFor(() => expect(screen.queryByText('📁 → Recipes')).toBeNull());
  expect(screen.getByText('#cooking')).toBeTruthy();
});

test('lists a folder-only recommendation when no existing folder matches (create chip)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Lone link', collection_id: null })],
    undefined,
    // No tag suggestions, only a proposed (non-existent) collection name.
    [makeEnrichment({ bookmark_id: id, suggested_collection_name: 'Travel' })],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Lone link')).toBeTruthy());
  expect(screen.getByText('📁 ＋ Create “Travel”')).toBeTruthy();
  // Folder-only card -> singular "Accept"/"Dismiss" bulk labels (not the plural
  // "all" forms, which only show when tags are present).
  expect(screen.queryByText('Accept all')).toBeNull();
  expect(screen.getByText('Accept')).toBeTruthy();
  expect(screen.getByText('Dismiss')).toBeTruthy();

  // Dismissing the folder via its ✕ clears the (folder-only) card.
  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Travel for Lone link'));
  await waitFor(() => expect(screen.queryByText('Lone link')).toBeNull());
});

test('dismissing a folder in Review persists durably (shared with Detail)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c3';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Lone link', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_collection_name: 'Travel' })],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('📁 ＋ Create “Travel”')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Dismiss suggested collection Travel for Lone link'));

  // Written to the durable, cross-screen store — not a session-only Set — so the
  // dismissal sticks on re-entry and is honored by Detail/Inbox/Settings too.
  await waitFor(() =>
    expect(fakeRepo.__meta('dismissed_folder_suggestions')).toContain('name:travel'),
  );
});

test('a durably-dismissed folder is hidden on Review entry', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c4';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Lone link', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_collection_name: 'Travel' })],
  );
  // A prior dismissal (from any screen) already in the durable store.
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [id]: ['name:travel'] }));

  const screen = await renderReview();

  // The folder-only card never appears — the queue is empty.
  await waitFor(() => expect(screen.getByText('No suggestions to review.')).toBeTruthy());
  expect(screen.queryByText('Lone link')).toBeNull();
});

test('"Accept all" clears the card', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b3';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Accept me' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.8 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Accept me')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Accept all suggestions for Accept me'));

  await waitFor(() => expect(screen.queryByText('Accept me')).toBeNull());
});

const TWO_COLLECTIONS = (now = '2026-06-12T00:00:00.000Z') => ({
  tags: [],
  bookmarkTags: [],
  collections: [
    { id: 'col-recipes', user_id: 'user-test', name: 'Recipes', description: null, created_at: now, updated_at: now },
    { id: 'col-watch', user_id: 'user-test', name: 'Watch Later', description: null, created_at: now, updated_at: now },
  ],
});

test('bulk "Accept all" on tags + existing-folder files into the folder', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Tags and folder', collection_id: null })],
    TWO_COLLECTIONS(),
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_collection_id: 'col-recipes',
        suggested_tags: [{ name: 'cooking', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Tags and folder')).toBeTruthy());
  expect(screen.getByText('📁 → Recipes')).toBeTruthy();

  // One press applies the tag AND files into the existing folder; with nothing
  // left pending (tag accepted, bookmark now IN the suggested folder so it stops
  // surfacing) the whole card drops out.
  await fireEvent.press(screen.getByLabelText('Accept all suggestions for Tags and folder'));
  await waitFor(() => expect(screen.queryByText('Tags and folder')).toBeNull());
  expect(screen.queryByText('📁 → Recipes')).toBeNull();
  expect(screen.queryByText('#cooking')).toBeNull();
});

test('bulk "Accept all" on tags + create-folder accepts the tags and runs the create path', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Tags and create', collection_id: null })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_collection_name: 'Travel',
        suggested_tags: [{ name: 'cooking', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Tags and create')).toBeTruthy());
  expect(screen.getByText('📁 ＋ Create “Travel”')).toBeTruthy();

  // "Accept all" now covers a create folder too (no "Accept tags" degradation):
  // it accepts the tag AND runs createCollection→assign. The tag is accepted
  // immediately (its chip vanishes). createCollection needs the cloud, which the
  // not_configured test auth can't reach, so the folder chip remains rather than
  // silently succeeding — proving the create was attempted, not skipped.
  await fireEvent.press(screen.getByLabelText('Accept all suggestions for Tags and create'));
  await waitFor(() => expect(screen.queryByText('#cooking')).toBeNull());
  expect(screen.getByText('📁 ＋ Create “Travel”')).toBeTruthy();
});

test('a CHANGE chip strikes the current folder and shows the move target; tapping files in with an Undo toast', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d3';
  // The bookmark already lives in "Watch Later"; the AI suggests "Recipes" — a
  // move, so the chip reads ~~Watch Later~~ → Recipes.
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Move me', collection_id: 'col-watch' })],
    TWO_COLLECTIONS(),
    [makeEnrichment({ bookmark_id: id, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Move me')).toBeTruthy());

  // Both names render (the from name struck, the target tinted) as separate runs.
  const fromRun = screen.getByText('Watch Later');
  expect(fromRun).toBeTruthy();
  expect(screen.getByText('→ Recipes')).toBeTruthy();
  // The "from" name is a REAL strikethrough run (the user's explicit ask), not
  // literal ~~ characters — assert the line-through style is applied.
  expect(StyleSheet.flatten(fromRun.props.style)).toMatchObject({
    textDecorationLine: 'line-through',
  });
  // The chip a11y spells out the move for screen readers (no visible strikethrough).
  const chip = screen.getByLabelText('Move Move me from Watch Later to Recipes');
  expect(chip).toBeTruthy();

  // Tapping files into Recipes — no confirm — and surfaces a "Moved" toast.
  // Once filed into the suggested folder the move suggestion stops surfacing.
  await fireEvent.press(chip);
  await waitFor(() => expect(screen.getByText('Moved to “Recipes”')).toBeTruthy());
  await waitFor(() => expect(screen.queryByText('→ Recipes')).toBeNull());

  // Undo restores the prior collection (back in Watch Later) — the move
  // suggestion re-surfaces, proving the bookmark was moved back, not nowhere.
  await fireEvent.press(screen.getByLabelText('Undo'));
  await waitFor(() => expect(screen.getByText('→ Recipes')).toBeTruthy());
  expect(screen.getByText('Watch Later')).toBeTruthy();
});

test('bulk "Dismiss all" dismisses the folder durably alongside the tags', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d4';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Dismiss everything', collection_id: null })],
    TWO_COLLECTIONS(),
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_collection_id: 'col-recipes',
        suggested_tags: [{ name: 'cooking', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Dismiss everything')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions for Dismiss everything'));

  // Tags reviewed + folder durably dismissed -> the card drops out and the
  // folder dismissal is written to the cross-screen durable store.
  await waitFor(() => expect(screen.queryByText('Dismiss everything')).toBeNull());
  await waitFor(() =>
    expect(fakeRepo.__meta('dismissed_folder_suggestions')).toContain('id:col-recipes'),
  );
});
