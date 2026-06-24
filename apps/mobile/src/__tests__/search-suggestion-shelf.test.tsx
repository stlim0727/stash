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
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { RECENT_SEARCHES_PREF_KEY } from '@/domain/recent-searches';
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

const SEARCH_PLACEHOLDER = 'Search titles, tags, folders';

function renderInbox() {
  return render(
    <BookmarksProvider>
      <InboxScreen />
    </BookmarksProvider>,
  );
}

/**
 * Seed an inbox with one tagged, foldered bookmark plus a stored recent search,
 * so the focused-empty shelf has a recent, a tag, and a folder chip.
 */
function seedTaggedLibrary() {
  const id = '7e64cf1e-0000-4000-8000-0000000000c1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Design system', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        {
          bookmark_id: id,
          tag_id: 't-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['local-first']));
}

async function focusSearch(screen: Awaited<ReturnType<typeof render>>) {
  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  await act(async () => {
    fireEvent(input, 'focus');
  });
  return input;
}

test('focusing the empty field shows the suggestion shelf and hides the browse shelf', async () => {
  seedTaggedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  // Before focus: the browse shelf is shown, the suggestion shelf is not.
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();
  expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull();

  await focusSearch(screen);

  // After focus (empty query): the suggestion shelf takes the slot; the browse
  // shelf is hidden (mutual exclusion).
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
  expect(screen.getByText('Jump to')).toBeTruthy();
});

test('the shelf shows a recent, a #tag, and a folder chip', async () => {
  seedTaggedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());
  await focusSearch(screen);

  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  // Recent (clock-icon chip): label = the raw query string.
  expect(screen.getByLabelText('Search again for “local-first”')).toBeTruthy();
  // Tag chip: #design, applies the tag facet on tap.
  expect(screen.getByLabelText('Filter by tag design')).toBeTruthy();
  // Folder chip: the collection name, applies the folder facet.
  expect(screen.getByLabelText('Filter by folder Work')).toBeTruthy();
});

test('tapping a recent chip fills the query and keeps the field focused', async () => {
  seedTaggedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());
  const input = await focusSearch(screen);

  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Search again for “local-first”'));
  });

  // The query is filled (the field echoes it) and the shelf closes because the
  // query is no longer empty — but focus was never blurred.
  expect(input.props.value).toBe('local-first');
  await waitFor(() => expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull());
});

test('tapping a tag chip applies the tag facet and clears the query', async () => {
  const tagged = '7e64cf1e-0000-4000-8000-0000000000c2';
  const untagged = '7e64cf1e-0000-4000-8000-0000000000c3';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: tagged, title: 'Design system' }),
      makeStoredBookmark({ id: untagged, title: 'Unrelated note' }),
    ],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        {
          bookmark_id: tagged,
          tag_id: 't-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());
  const input = await focusSearch(screen);

  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Filter by tag design'));
  });

  // Facet applied (only the tagged bookmark remains), query cleared.
  await waitFor(() => expect(screen.getByText('#design · 1')).toBeTruthy());
  expect(screen.getByText('Design system')).toBeTruthy();
  expect(screen.queryByText('Unrelated note')).toBeNull();
  expect(input.props.value).toBe('');
});

test('submitting a query records it to the recents store', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  await act(async () => {
    fireEvent.changeText(input, '  kimchi  ');
  });
  await act(async () => {
    fireEvent(input, 'submitEditing', { nativeEvent: { text: '  kimchi  ' } });
  });

  // The recents pref is persisted with the trimmed query.
  await waitFor(async () => {
    const raw = await fakeRepo.repository.getMeta(RECENT_SEARCHES_PREF_KEY);
    expect(JSON.parse(raw ?? '[]')).toEqual(['kimchi']);
  });
});

test('an empty library renders no suggestion shelf on focus', async () => {
  // No tags, no folders, no recents — there is nothing to suggest, so the shelf
  // never appears (we never show an empty container).
  fakeRepo.__reset([makeStoredBookmark({ title: 'Lonely link', collection_id: null })]);
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Lonely link')).toBeTruthy());

  await focusSearch(screen);

  // A beat to let any focus-driven render settle, then assert nothing showed.
  await act(async () => {});
  expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull();
  expect(screen.queryByText('Jump to')).toBeNull();
});

test('blurring the field hides the suggestion shelf and restores the browse shelf', async () => {
  seedTaggedLibrary();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());
  const input = await focusSearch(screen);

  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await act(async () => {
    fireEvent(input, 'blur');
  });

  await waitFor(() => expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull());
  expect(screen.getByTestId('browse-shelf')).toBeTruthy();
});

test('long-pressing a recent chip removes just that entry', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000c4';
  fakeRepo.__reset([makeStoredBookmark({ id, title: 'A bookmark' })]);
  // Two recents so removing one leaves the other (and the shelf still shows).
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['design', 'recipes']));

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A bookmark')).toBeTruthy());
  await focusSearch(screen);

  await waitFor(() => expect(screen.getByLabelText('Search again for “design”')).toBeTruthy());

  await act(async () => {
    fireEvent(screen.getByLabelText('Search again for “design”'), 'longPress');
  });

  // The removed recent is gone from the shelf, the other remains, and the store
  // no longer holds it.
  await waitFor(() => expect(screen.queryByLabelText('Search again for “design”')).toBeNull());
  expect(screen.getByLabelText('Search again for “recipes”')).toBeTruthy();
  const raw = await fakeRepo.repository.getMeta(RECENT_SEARCHES_PREF_KEY);
  expect(JSON.parse(raw ?? '[]')).toEqual(['recipes']);
});

// --- A) blur-during-tap unmount race -------------------------------------
//
// On native, tapping a suggestion chip blurs the TextInput FIRST, which would
// unmount the shelf mid-gesture if the hide were synchronous — the tap would
// land in the void. The screen defers the blur-driven hide one tick so the
// chip's onPress resolves against a still-mounted shelf. These tests reproduce
// that ordering with fake timers: fire `blur` (which schedules the deferred
// hide) and, WITHOUT advancing timers, press the chip. Against a synchronous
// hide the chip would already be gone and these would fail.

test('a recent tap survives a blur fired first (deferred-hide race)', async () => {
  jest.useFakeTimers();
  try {
    seedTaggedLibrary();
    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    await act(async () => {
      fireEvent(input, 'focus');
    });
    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // Blur lands first (the keyboard dismissing as the touch begins) — but the
    // hide is deferred, so the shelf is STILL mounted on this same tick …
    await act(async () => {
      fireEvent(input, 'blur');
    });
    expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();

    // … and the chip's press reaches its handler: the query fills.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Search again for “local-first”'));
    });
    expect(input.props.value).toBe('local-first');

    // Flushing the deferred hide does not strand a pending timer / warning.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a tag tap survives a blur fired first (deferred-hide race)', async () => {
  jest.useFakeTimers();
  try {
    const tagged = '7e64cf1e-0000-4000-8000-0000000000d1';
    const untagged = '7e64cf1e-0000-4000-8000-0000000000d2';
    fakeRepo.__reset(
      [
        makeStoredBookmark({ id: tagged, title: 'Design system' }),
        makeStoredBookmark({ id: untagged, title: 'Unrelated note' }),
      ],
      {
        tags: [makeTag('t-design', 'design')],
        bookmarkTags: [
          {
            bookmark_id: tagged,
            tag_id: 't-design',
            source: 'user',
            confidence: null,
            created_at: '2026-06-12T00:00:00.000Z',
          },
        ],
        collections: [],
      },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    await act(async () => {
      fireEvent(input, 'focus');
    });
    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // Blur first, shelf still mounted, tag press lands and applies the facet.
    await act(async () => {
      fireEvent(input, 'blur');
    });
    expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Filter by tag design'));
    });

    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    await waitFor(() => expect(screen.getByText('#design · 1')).toBeTruthy());
    expect(screen.queryByText('Unrelated note')).toBeNull();
    expect(input.props.value).toBe('');
  } finally {
    jest.useRealTimers();
  }
});

// --- B) screen-reader delete action --------------------------------------

test('a recent chip exposes a delete accessibility action that removes it', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d3';
  fakeRepo.__reset([makeStoredBookmark({ id, title: 'A bookmark' })]);
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['design', 'recipes']));

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A bookmark')).toBeTruthy());
  await focusSearch(screen);

  const chip = await screen.findByLabelText('Search again for “design”');
  // The destructive remove is exposed to VoiceOver/TalkBack as a named action,
  // not only as a sighted-only long-press.
  expect(chip.props.accessibilityActions).toEqual([
    { name: 'delete', label: 'Remove recent search “design”' },
  ]);

  // Invoking the action removes just that entry (same path as long-press).
  await act(async () => {
    fireEvent(chip, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });
  });
  await waitFor(() => expect(screen.queryByLabelText('Search again for “design”')).toBeNull());
  expect(screen.getByLabelText('Search again for “recipes”')).toBeTruthy();
  const raw = await fakeRepo.repository.getMeta(RECENT_SEARCHES_PREF_KEY);
  expect(JSON.parse(raw ?? '[]')).toEqual(['recipes']);
});

// --- D) screen-path coverage ---------------------------------------------

test('submitting "a" then "b" then "a" dedupes-to-front via the screen path', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  const submit = async (text: string) => {
    await act(async () => {
      fireEvent.changeText(input, text);
    });
    await act(async () => {
      fireEvent(input, 'submitEditing', { nativeEvent: { text } });
    });
    // Clear back to empty between submits (mirrors a user starting a fresh
    // search) so the next submit is observed on its own.
    await act(async () => {
      fireEvent.changeText(input, '');
    });
  };

  await submit('a');
  await submit('b');
  await submit('a');

  // Re-searching "a" promotes it to the front rather than duplicating: ['a','b'].
  await waitFor(async () => {
    const raw = await fakeRepo.repository.getMeta(RECENT_SEARCHES_PREF_KEY);
    expect(JSON.parse(raw ?? '[]')).toEqual(['a', 'b']);
  });
});

test('a corrupt recents pref does not break the screen; tag/folder chips still show', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000d4';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'Design system', collection_id: 'col-work' })],
    {
      tags: [makeTag('t-design', 'design')],
      bookmarkTags: [
        {
          bookmark_id: id,
          tag_id: 't-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [makeCollection('col-work', 'Work')],
    },
  );
  // A hand-edited / corrupt stored value must not throw — it parses to empty.
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, 'not json');

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());
  await focusSearch(screen);

  // The shelf still renders from the tag/folder sources; no recent chips.
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  expect(screen.getByLabelText('Filter by tag design')).toBeTruthy();
  expect(screen.getByLabelText('Filter by folder Work')).toBeTruthy();
  expect(screen.queryByLabelText(/^Search again for/)).toBeNull();
});
