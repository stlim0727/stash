import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { InteractionManager } from 'react-native';

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

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    dismissTo: mockDismissTo,
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

import GraphScreen, { clampToRange, maxPanOffset, MIN_SCALE, MAX_SCALE } from '@/app/graph';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Tag } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeTag(id: string, name: string): Tag {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, slug: name, source: 'user', created_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderScreen() {
  return render(
    <BookmarksProvider>
      <GraphScreen />
    </BookmarksProvider>,
  );
}

// The screen settles the layout OFF the render path, inside
// InteractionManager.runAfterInteractions. Capture those callbacks so the test
// controls when the settle runs — that lets us assert the loading state renders
// FIRST, then flush the settle and assert the graph.
let pendingInteractions: Array<() => void> = [];
beforeAll(() => {
  jest
    .spyOn(InteractionManager, 'runAfterInteractions')
    .mockImplementation((task?: (() => void) | { gen?: () => void }) => {
      if (typeof task === 'function') {
        pendingInteractions.push(task);
      }
      return { then: () => {}, done: () => {}, cancel: () => {} } as never;
    });
});

async function flushSettle() {
  await act(async () => {
    const tasks = pendingInteractions;
    pendingInteractions = [];
    for (const task of tasks) {
      task();
    }
  });
}

beforeEach(() => {
  mockPush.mockClear();
  mockDismissTo.mockClear();
  pendingInteractions = [];
});

// A small stash: two bookmarks, one shared tag, plus an untagged bookmark that
// parks under the synthetic hub.
function seedLibrary() {
  const cooked = '7e64cf1e-0000-4000-8000-0000000000a1';
  const reading = '7e64cf1e-0000-4000-8000-0000000000a2';
  const loose = '7e64cf1e-0000-4000-8000-0000000000a3';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: cooked, title: 'Kimchi jjigae' }),
      makeStoredBookmark({ id: reading, title: 'Local-first software' }),
      makeStoredBookmark({ id: loose, title: 'No tags here' }),
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
}

test('renders tag hubs, the untagged hub, and a node per bookmark', async () => {
  seedLibrary();

  const screen = await renderScreen();

  // With bookmarks to lay out, the loading state paints FIRST while the settle
  // runs off the render path — the graph only appears once we flush it.
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  expect(screen.getByText('Building your map…')).toBeTruthy();
  expect(screen.queryByTestId('graph-screen')).toBeNull();

  await flushSettle();

  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());
  // Two tag hubs, sized/labelled by how many bookmarks carry them.
  expect(screen.getByTestId('graph-tag-t-cooking')).toBeTruthy();
  expect(screen.getByTestId('graph-tag-t-reading')).toBeTruthy();
  expect(screen.getByLabelText('Tag cooking, 2 bookmarks')).toBeTruthy();
  expect(screen.getByLabelText('Tag reading, 1 bookmark')).toBeTruthy();
  // The untagged bookmark parks under the synthetic hub.
  expect(screen.getByTestId('graph-untagged-hub')).toBeTruthy();
  // One node per bookmark.
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a1')).toBeTruthy();
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a2')).toBeTruthy();
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a3')).toBeTruthy();
});

test('shows the empty state when there are no bookmarks', async () => {
  fakeRepo.__reset([], { tags: [], bookmarkTags: [], collections: [] });

  const screen = await renderScreen();

  await waitFor(() => expect(screen.getByTestId('graph-empty')).toBeTruthy());
  expect(screen.getByText('Nothing to map yet')).toBeTruthy();
  expect(screen.queryByTestId('graph-screen')).toBeNull();
  // An empty stash short-circuits to the empty state — never the spinner.
  expect(screen.queryByTestId('graph-loading')).toBeNull();
});

test('tapping a bookmark node routes to its detail', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  const node = await waitFor(() =>
    screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a1'),
  );

  await fireEvent.press(node);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/bookmark/[id]',
    params: { id: '7e64cf1e-0000-4000-8000-0000000000a1' },
  });
});

test('tapping a tag hub hands the facet to the root Inbox', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  const hub = await waitFor(() => screen.getByTestId('graph-tag-t-cooking'));

  await fireEvent.press(hub);
  expect(mockDismissTo).toHaveBeenCalledTimes(1);
  const [arg] = mockDismissTo.mock.calls[0];
  expect(arg.pathname).toBe('/');
  expect(arg.params.tag).toBe('t-cooking');
  // A monotonic nonce rides along so a same-tag re-tap still re-applies.
  expect(arg.params.t).toBeTruthy();
});

// The pan is clamped so a fling can't drift the graph into empty space. These
// exercise the exact math the panResponder runs each frame: it clamps the
// ABSOLUTE resulting position (panStart + gesture delta) into ±maxPanOffset,
// where maxPanOffset grows with the zoom-in overflow. PanResponder's gestureState
// isn't computed under the jest event pipeline (no native touchHistory), so we
// assert the bound + clamp directly rather than through synthetic touch events.
describe('pan clamp', () => {
  const W = 320;
  const H = 640;

  test('at scale 1 the fitted content pins the pan to a small margin', () => {
    // The SVG already fits the viewport at scale 1, so a huge fling barely moves.
    const maxX = maxPanOffset(1, W);
    expect(maxX).toBe(32);
    expect(clampToRange(0 + 99999, -maxX, maxX)).toBe(32);
    expect(clampToRange(0 - 99999, -maxX, maxX)).toBe(-32);
  });

  test('bounds hold at MIN_SCALE (content smaller than the viewport)', () => {
    const maxX = maxPanOffset(MIN_SCALE, W);
    const maxY = maxPanOffset(MIN_SCALE, H);
    // At s < 1 the content is no larger than the viewport → pinned to ±margin.
    expect(maxX).toBe(32);
    expect(maxY).toBe(32);
    expect(clampToRange(5000, -maxX, maxX)).toBe(maxX);
    expect(clampToRange(-5000, -maxY, maxY)).toBe(-maxY);
  });

  test('bounds hold at MAX_SCALE and still bound a large fling', () => {
    const maxX = maxPanOffset(MAX_SCALE, W); // (6-1)*320/2 + 32
    const maxY = maxPanOffset(MAX_SCALE, H); // (6-1)*640/2 + 32
    expect(maxX).toBe(832);
    expect(maxY).toBe(1632);
    // A giant drag is clamped to the axis bound, never beyond → never off-screen.
    expect(clampToRange(50000, -maxX, maxX)).toBe(maxX);
    expect(clampToRange(-50000, -maxY, maxY)).toBe(-maxY);
    // In-range positions pass through untouched so edge nodes stay reachable.
    expect(clampToRange(400, -maxX, maxX)).toBe(400);
  });

  test('zooming in strictly widens the pan range', () => {
    expect(maxPanOffset(MAX_SCALE, W)).toBeGreaterThan(maxPanOffset(2, W));
    expect(maxPanOffset(2, W)).toBeGreaterThan(maxPanOffset(1, W));
  });
});

test('an all-untagged stash reads as intentional with the add-tags hint', async () => {
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000b1', title: 'Loose one' })],
    { tags: [], bookmarkTags: [], collections: [] },
  );

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  await waitFor(() => expect(screen.getByTestId('graph-untagged-hub')).toBeTruthy());
  // No tag hubs, so the "add tags to see connections" hint surfaces.
  expect(screen.getByText('Add tags to your bookmarks to see how they connect.')).toBeTruthy();
});
