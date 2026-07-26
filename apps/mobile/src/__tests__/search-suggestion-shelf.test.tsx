import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
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
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
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

const SEARCH_PLACEHOLDER = 'Search titles, tags, collections';

function renderInbox() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
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
  // Search is tap-to-open: reveal the field via the hero magnifier before it
  // exists in the tree, then focus it.
  await act(async () => {
    fireEvent.press(screen.getByTestId('inbox-search-open'));
  });
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
  expect(screen.getByLabelText('Filter by collection Work')).toBeTruthy();
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

  // The query is filled (the field echoes it) and the field was never blurred —
  // the recent fills + keeps focus so the user can keep editing. Phase 2: the
  // shelf re-filters to the now-non-empty query (here "local-first" matches no
  // tag/folder/other-recent, so it has nothing to suggest and hides) — the
  // browse shelf must NOT reappear while still focused.
  expect(input.props.value).toBe('local-first');
  await waitFor(() => expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull());
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
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
  await waitFor(() => expect(screen.getByText('Filtered: #design')).toBeTruthy());
  expect(screen.getByText('Design system')).toBeTruthy();
  expect(screen.queryByText('Unrelated note')).toBeNull();
  expect(input.props.value).toBe('');
});

test('submitting a query records it to the recents store', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('inbox-search-open'));
  });
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

    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-search-open'));
    });
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

    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-search-open'));
    });
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
    await waitFor(() => expect(screen.getByText('Filtered: #design')).toBeTruthy());
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

  await act(async () => {
    fireEvent.press(screen.getByTestId('inbox-search-open'));
  });
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
  expect(screen.getByLabelText('Filter by collection Work')).toBeTruthy();
  expect(screen.queryByLabelText(/^Search again for/)).toBeNull();
});

// ── Phase 2: live filter as you type (§13) ───────────────────────────────
//
// Seed a library whose families exercise the filter: a `#design` tag and a
// `databases` tag (so `des` keeps one, drops the other), a `Design` folder, and
// a `design system` recent. Two bookmarks — one tagged `#design`, one tagged
// only `databases` — so the shelf and the "Matches (N)" results can be checked
// for agreement.
function seedPhase2Library() {
  const designed = '7e64cf1e-0000-4000-8000-0000000000e1';
  const databased = '7e64cf1e-0000-4000-8000-0000000000e2';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: designed, title: 'A design doc', collection_id: 'col-design' }),
      makeStoredBookmark({ id: databased, title: 'A database doc', collection_id: null }),
    ],
    {
      tags: [makeTag('t-design', 'design'), makeTag('t-databases', 'databases')],
      bookmarkTags: [
        {
          bookmark_id: designed,
          tag_id: 't-design',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
        {
          bookmark_id: databased,
          tag_id: 't-databases',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [makeCollection('col-design', 'Design')],
    },
  );
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['design system']));
}

// The TextInput element type, derived from what `getByPlaceholderText` returns
// (RNTL's ReactTestInstance) — avoids depending on react-test-renderer types.
type Input = ReturnType<Awaited<ReturnType<typeof renderInbox>>['getByPlaceholderText']>;
async function typeQuery(input: Input, text: string) {
  await act(async () => {
    fireEvent.changeText(input, text);
  });
}

test('typing filters the shelf to matches and drops non-matching chips', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'des');

  // The shelf stays mounted and (once the 140ms debounce settles) shows only the
  // chips matching "des": the `design system` recent, the #design tag, and the
  // Design folder — but NOT the `databases` tag. Wait on the non-match dropping
  // out (that transition is what proves the debounced filter applied).
  await waitFor(() => expect(screen.queryByLabelText('Filter by tag databases')).toBeNull());
  expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();
  expect(screen.getByLabelText('Search again for “design system”')).toBeTruthy();
  expect(screen.getByLabelText('Filter by tag design')).toBeTruthy();
  expect(screen.getByLabelText('Filter by collection Design')).toBeTruthy();
});

test('typing orders the shelf recent → tag → folder (cross-family grouping)', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'des');
  // Wait for the debounced filter to land (the non-matching tag drops out).
  await waitFor(() => expect(screen.queryByLabelText('Filter by tag databases')).toBeNull());

  // The matching recent appears before the matching tag before the folder. Read
  // the shelf's chip testIDs in tree order (getAllByTestId returns matches in
  // document order) — recents → tags → folders.
  const order = screen
    .getAllByTestId(/^suggestion-(recent|tag|folder)-/)
    .map((node) => node.props.testID as string);
  const families = order.map((id) => id.split('-')[1]);
  expect(families).toEqual(['recent', 'tag', 'folder']);
});

test('typing with no shelf match shows NEITHER the suggestion shelf NOR the browse shelf', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'zzz');

  // No recent/tag/folder matches "zzz" → the suggestion shelf hides; and while
  // focused the browse shelf must NOT reappear. The field-only header.
  await waitFor(() => expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull());
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
  expect(screen.queryByText('Jump to')).toBeNull();
  // The zero-result empty state MUST render — this guards against a regression
  // where `searching` is computed from the raw query instead of debouncedQuery.
  expect(screen.getByTestId('inbox-empty-search')).toBeTruthy();
});

test('tapping a filtered tag chip applies the facet and clears the query', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'des');
  await waitFor(() => expect(screen.getByLabelText('Filter by tag design')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Filter by tag design'));
  });

  // The tag facet is applied (only the #design bookmark remains) and the search
  // UI folds away onto the filtered list — the tap-to-open field unmounts, which
  // is the new "query cleared" end-state.
  await waitFor(() => expect(screen.getByText('Filtered: #design')).toBeTruthy());
  expect(screen.getByText('A design doc')).toBeTruthy();
  expect(screen.queryByText('A database doc')).toBeNull();
  expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
});

test('tapping a matched recent fills the query and keeps focus', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'des');
  await waitFor(() => expect(screen.getByLabelText('Search again for “design system”')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Search again for “design system”'));
  });

  // The recent completes the query and never blurs the field. The shelf still
  // shows (the full "design system" recent equals the query so it's dropped, but
  // #design / Design still match) — the browse shelf stays hidden either way.
  expect(input.props.value).toBe('design system');
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
});

test('the shelf and the results agree on what matches the query', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  const input = await focusSearch(screen);
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

  await typeQuery(input, 'des');

  // Results: the #design-tagged bookmark matches (via its title/tag); the
  // databases-only bookmark does not — exactly the set the shelf surfaced
  // (#design shown, databases dropped). Same matcher, no disagreement. Wait for
  // the debounced results filter to drop the non-match.
  await waitFor(() => expect(screen.queryByText('A database doc')).toBeNull());
  expect(screen.getByText('A design doc')).toBeTruthy();
});

test('focus-empty still shows the FULL unfiltered shelf (Phase-1 regression guard)', async () => {
  seedPhase2Library();
  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
  await focusSearch(screen);

  // With an empty query the shelf is the Phase-1 focus-empty shelf: the recent,
  // BOTH tags (design AND databases), and the folder — nothing filtered out.
  await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());
  expect(screen.getByLabelText('Search again for “design system”')).toBeTruthy();
  expect(screen.getByLabelText('Filter by tag design')).toBeTruthy();
  expect(screen.getByLabelText('Filter by tag databases')).toBeTruthy();
  expect(screen.getByLabelText('Filter by collection Design')).toBeTruthy();
});

// Phase-2 variant of the blur-during-tap race: the user has already typed a
// query (shelf shows filtered chips), then blur fires before the tap resolves.
// The deferred-hide mechanism must protect the chip just as it does from
// the focus-empty state.
test('a filtered chip tap survives a blur fired first (Phase-2 typing race)', async () => {
  jest.useFakeTimers();
  try {
    seedPhase2Library();
    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('A design doc')).toBeTruthy());
    const input = await focusSearch(screen);
    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // Type “des” — shelf filters to the matching chips.
    await act(async () => {
      fireEvent.changeText(input, 'des');
    });
    await waitFor(() => expect(screen.queryByLabelText('Filter by tag databases')).toBeNull());

    // Blur fires first (native tap-begin gesture), but the deferred hide keeps
    // the shelf mounted on this same tick …
    await act(async () => {
      fireEvent(input, 'blur');
    });
    expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();

    // … so the filtered tag chip's press still reaches its handler.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Filter by tag design'));
    });
    // The facet is applied and the search UI folds away (the tap-to-open field
    // unmounts) — the tap succeeded and the query is cleared.
    await waitFor(() => expect(screen.getByText('Filtered: #design')).toBeTruthy());
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();

    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  } finally {
    jest.useRealTimers();
  }
});

// --- Keyboard dismissed without a blur (Android Back button) -----------------
//
// On Android, dismissing the keyboard with the hardware/gesture Back button (or
// an on-drag list scroll) does NOT fire the TextInput's onBlur, so the focused-
// only suggestion shelf would be stranded on screen with no keyboard. The screen
// listens for `keyboardDidHide` and drops the focused state. This reproduces it
// by capturing the registered handler and invoking it WITHOUT firing `blur`.
test('keyboard-hide without a blur drops the stranded shelf (Android Back button)', async () => {
  const handlers: Array<() => void> = [];
  const addSpy = jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation(((event: string, cb: () => void) => {
      if (event === 'keyboardDidHide') {
        handlers.push(cb);
      }
      return { remove: jest.fn() };
    }) as unknown as typeof Keyboard.addListener);
  try {
    seedTaggedLibrary();
    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-search-open'));
    });
    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    await act(async () => {
      fireEvent(input, 'focus');
    });
    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // The keyboard hides but NO blur fires (the Android Back-button case).
    expect(handlers.length).toBeGreaterThan(0);
    await act(async () => {
      handlers.forEach((cb) => cb());
    });

    // The shelf is gone and the browse shelf is restored — no longer stranded.
    await waitFor(() => expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull());
    expect(screen.getByTestId('browse-shelf')).toBeTruthy();
  } finally {
    addSpy.mockRestore();
  }
});

// The keyboard-hide handler routes its hide through the SAME deferred timer the
// onBlur path uses, so a chip onPress racing a keyboard dismissal (e.g. a fling
// that dismisses the keyboard and lands a chip tap) still resolves against a
// mounted shelf. Fire the handler, then press a chip BEFORE flushing the timer.
test('keyboard-hide defers its hide so a chip tap mid-dismiss still lands', async () => {
  jest.useFakeTimers();
  const handlers: Array<() => void> = [];
  const addSpy = jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation(((event: string, cb: () => void) => {
      if (event === 'keyboardDidHide') {
        handlers.push(cb);
      }
      return { remove: jest.fn() };
    }) as unknown as typeof Keyboard.addListener);
  try {
    seedTaggedLibrary();
    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-search-open'));
    });
    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    await act(async () => {
      fireEvent(input, 'focus');
    });
    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // Keyboard dismisses — the hide is SCHEDULED, not synchronous, so the shelf is
    // still mounted on this tick …
    await act(async () => {
      handlers.forEach((cb) => cb());
    });
    expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();

    // … so a tag chip's press still reaches its handler and applies the facet.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Filter by tag design'));
    });
    expect(input.props.value).toBe('');

    // Flushing the deferred hide leaves no stray timer / setState-after-unmount.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  } finally {
    addSpy.mockRestore();
    jest.useRealTimers();
  }
});
