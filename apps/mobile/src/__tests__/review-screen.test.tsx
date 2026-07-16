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
import { summaryToken } from '@/domain/ai-suggestions';
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

test('keeps bulk actions anchored before the wrapping suggestion chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000a2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Many suggestions' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.8 },
          { name: 'reading', confidence: 0.8 },
          { name: 'research', confidence: 0.8 },
          { name: 'archive', confidence: 0.8 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Many suggestions')).toBeTruthy());
  expect(screen.getByLabelText('Accept all suggestions for Many suggestions')).toBeTruthy();
  expect(screen.getByLabelText('Dismiss all suggestions for Many suggestions')).toBeTruthy();

  const card = screen.getByTestId(`review-card-${id}`);
  const childTestIds = card.children.map((child) =>
    typeof child === 'string' ? null : child.props.testID,
  );

  expect(childTestIds.indexOf(`review-action-row-${id}`)).toBeGreaterThan(-1);
  expect(childTestIds.indexOf(`review-action-row-${id}`)).toBeLessThan(
    childTestIds.indexOf(`review-chip-row-${id}`),
  );
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

test('"Dismiss all" for visible tags does not persist a hidden folder dismissal', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000b4';
  const now = '2026-06-12T00:00:00.000Z';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Already filed', collection_id: 'col-recipes' })],
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
        suggested_collection_name: 'Recipes',
        suggested_tags: [{ name: 'cooking', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Already filed')).toBeTruthy());
  expect(screen.queryByText('📁 Recipes')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions for Already filed'));

  await waitFor(() => expect(screen.queryByText('Already filed')).toBeNull());
  expect(fakeRepo.__bookmarks().find((b) => b.id === '7e64cf1e-0000-4000-8000-0000000000b4')?.dismissed_suggested_folders?.length ?? 0).toBe(0);
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

test('accepting a folder recommendation records it so undoing the move does not re-surface it', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c9';
  const now = '2026-06-12T00:00:00.000Z';
  // The bookmark already lives in "Watch Later"; the AI suggests "Recipes" — a
  // move, so accepting offers an Undo toast.
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Move me', collection_id: 'col-watch' })],
    TWO_COLLECTIONS(now),
    [makeEnrichment({ bookmark_id: id, suggested_collection_id: 'col-recipes' })],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Move me')).toBeTruthy());

  // Accepting the move records the decision durably (mirrors an accepted tag),
  // not just "the bookmark now lives there".
  await fireEvent.press(screen.getByLabelText('Move Move me from Watch Later to Recipes'));
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.dismissed_suggested_folders).toContain('id:col-recipes'),
  );

  // Undo moves the bookmark back to Watch Later, but the recommendation stays
  // gone — the user already decided on it.
  await fireEvent.press(screen.getByLabelText('Undo'));
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.collection_id).toBe('col-watch'),
  );
  expect(screen.queryByText('→ Recipes')).toBeNull();
  await waitFor(() => expect(screen.getByText('No suggestions to review.')).toBeTruthy());
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
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.dismissed_suggested_folders).toContain('name:travel'),
  );
});

test('a durably-dismissed folder is hidden on Review entry', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c4';
  // A prior dismissal (from any screen) already in the durable store.
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Lone link', collection_id: null, dismissed_suggested_folders: ['name:travel'] })],
    undefined,
    [makeEnrichment({ bookmark_id: id, suggested_collection_name: 'Travel' })],
  );

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

  // Undo restores the prior collection (back in Watch Later) — verified by the
  // stored row, not by the suggestion re-appearing. Accepting the recommendation
  // is a decision the user made, so undoing the *move* must NOT bring the
  // recommendation back (the prior bug); it stays gone like an accepted tag does.
  await fireEvent.press(screen.getByLabelText('Undo'));
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.collection_id).toBe('col-watch'),
  );
  expect(screen.queryByText('→ Recipes')).toBeNull();
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
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.dismissed_suggested_folders).toContain('id:col-recipes'),
  );
});

test('surfaces an AI summary as a proposed note alongside tag chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Summarized page' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A concise overview of the article.',
        model: 'gemini-2.0',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Summarized page')).toBeTruthy());
  expect(screen.getByText('A concise overview of the article.')).toBeTruthy();
  expect(screen.getByText('#design')).toBeTruthy();
});

test('a summary-only card (no tags, no folder) skips the bulk Accept/Dismiss row', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e2';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Summary only' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A url from example.com.',
        model: 'gemini-2.0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('A url from example.com.')).toBeTruthy());
  expect(screen.queryByTestId(`review-action-row-${id}`)).toBeNull();
  expect(screen.getByLabelText('Use the suggested summary as your note for Summary only')).toBeTruthy();
});

test('"Use as note" fills an empty note and marks the summary durably reviewed', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e3';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Fill my note', notes: null })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A concise overview of the article.',
        model: 'gemini-2.0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() =>
    expect(screen.getByLabelText('Use the suggested summary as your note for Fill my note')).toBeTruthy(),
  );

  await fireEvent.press(screen.getByLabelText('Use the suggested summary as your note for Fill my note'));

  await waitFor(() => {
    const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
    expect(bookmark?.notes).toBe('A concise overview of the article.');
    expect(bookmark?.reviewed_summary_tokens).toContain(summaryToken('A concise overview of the article.')!);
  });
  // Nothing else was pending, so the card drops out once the summary is used.
  await waitFor(() => expect(screen.queryByText('Fill my note')).toBeNull());
});

test('"Add to note" appends the summary without overwriting existing text', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e4';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Append to note', notes: 'My own thoughts.' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'An AI overview.',
        model: 'gemini-2.0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() =>
    expect(
      screen.getByLabelText('Add the suggested summary to your note for Append to note'),
    ).toBeTruthy(),
  );

  await fireEvent.press(screen.getByLabelText('Add the suggested summary to your note for Append to note'));

  await waitFor(() => {
    const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
    expect(bookmark?.notes).toBe('My own thoughts.\n\nAn AI overview.');
  });
});

test('dismissing the summary hides it durably and never touches the note', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e5';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Dismiss my summary', notes: 'Untouched.' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A summary to dismiss.',
        model: 'gemini-2.0',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() =>
    expect(screen.getByLabelText('Dismiss the suggested summary for Dismiss my summary')).toBeTruthy(),
  );

  await fireEvent.press(screen.getByLabelText('Dismiss the suggested summary for Dismiss my summary'));

  await waitFor(() => expect(screen.queryByText('Dismiss my summary')).toBeNull());
  const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
  expect(bookmark?.notes).toBe('Untouched.');
  expect(bookmark?.reviewed_summary_tokens).toContain(summaryToken('A summary to dismiss.')!);
});

test('a dummy-v0 summary never surfaces on Review (would leak the internal model name)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e6';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Dummy summary' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'Url from example.com — “○○”. Auto-categorized by dummy-v0.',
        model: 'dummy-v0',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Dummy summary')).toBeTruthy());
  expect(screen.queryByText('Url from example.com — “○○”. Auto-categorized by dummy-v0.')).toBeNull();
  expect(screen.queryByLabelText('Use the suggested summary as your note for Dummy summary')).toBeNull();
});

test('a durably-reviewed summary is hidden on Review entry', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e7';
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id,
        title: 'Already reviewed',
        reviewed_summary_tokens: [summaryToken('Already-reviewed summary.')!],
      }),
    ],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'Already-reviewed summary.',
        model: 'gemini-2.0',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Already reviewed')).toBeTruthy());
  expect(screen.queryByText('Already-reviewed summary.')).toBeNull();
});

test('bulk "Dismiss all" on a mixed card (tags + summary) also dismisses the summary', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e8';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Mixed card', notes: 'Untouched.' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A mixed-card summary.',
        model: 'gemini-2.0',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Mixed card')).toBeTruthy());
  expect(screen.getByText('A mixed-card summary.')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('Dismiss all suggestions for Mixed card'));

  // "Dismiss all" sweeps the tag AND the summary — the card fully drops out,
  // and the summary is durably reviewed (not just the tag).
  await waitFor(() => expect(screen.queryByText('Mixed card')).toBeNull());
  const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
  expect(bookmark?.notes).toBe('Untouched.');
  expect(bookmark?.reviewed_summary_tokens).toContain(summaryToken('A mixed-card summary.')!);
});

test('a stale enrichment shows the same hint as Detail', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e9';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Stale card' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A stale summary.',
        model: 'gemini-2.0',
        status: 'stale',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('Stale card')).toBeTruthy());
  expect(screen.getByText('Edited since these suggestions — refresh to update.')).toBeTruthy();
});

test('the singular "Dismiss" on a folder-only card leaves an accompanying summary untouched', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000ea';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Folder plus summary', collection_id: null })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'A folder-card summary.',
        model: 'gemini-2.0',
        suggested_collection_name: 'Travel',
        suggested_tags: [],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('📁 ＋ Create “Travel”')).toBeTruthy());
  expect(screen.getByText('A folder-card summary.')).toBeTruthy();
  // Folder-only (no tags) -> the singular "Dismiss" a11y label, not "Dismiss all".
  expect(screen.getByLabelText('Dismiss the suggestion for Folder plus summary')).toBeTruthy();
  expect(screen.queryByLabelText('Dismiss all suggestions for Folder plus summary')).toBeNull();

  // Press the bulk row's singular "Dismiss" (not the folder chip's own ✕) —
  // this is the button dismissAll's tags/folder-plus-summary gating covers.
  await fireEvent.press(screen.getByLabelText('Dismiss the suggestion for Folder plus summary'));

  // Only the folder suggestion is gone — the summary widget (and its own
  // "Use as note" control) is still there, untouched.
  await waitFor(() => expect(screen.queryByText('📁 ＋ Create “Travel”')).toBeNull());
  expect(screen.getByText('A folder-card summary.')).toBeTruthy();
  expect(
    screen.getByLabelText('Use the suggested summary as your note for Folder plus summary'),
  ).toBeTruthy();
  const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
  expect(bookmark?.reviewed_summary_tokens ?? []).not.toContain(summaryToken('A folder-card summary.')!);
});

test('"Accept all" on a mixed card (tags + summary) also uses the summary as a note', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000eb';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Accept everything', notes: null })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        summary: 'An accept-all summary.',
        model: 'gemini-2.0',
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
    ],
  );

  const screen = await renderReview();
  await waitFor(() => expect(screen.getByText('Accept everything')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Accept all suggestions for Accept everything'));

  // "Accept all" now genuinely means all: the tag is applied AND the summary
  // is used as the note, so the card fully drops out.
  await waitFor(() => expect(screen.queryByText('Accept everything')).toBeNull());
  const bookmark = fakeRepo.__bookmarks().find((b) => b.id === id);
  expect(bookmark?.notes).toBe('An accept-all summary.');
  expect(bookmark?.reviewed_summary_tokens).toContain(summaryToken('An accept-all summary.')!);
});
