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

// A small stash: `cooking` is shared by two bookmarks (survives the ≥2 shared-tag
// backbone filter), `reading` is single-use (filtered out — its bookmark keeps the
// shared `cooking` tag), plus an untagged bookmark that parks under the synthetic hub.
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

test('renders the shared-tag backbone hub, the untagged hub, and a node per bookmark', async () => {
  seedLibrary();

  const screen = await renderScreen();

  // With bookmarks to lay out, the loading state paints FIRST while the settle
  // runs off the render path — the graph only appears once we flush it.
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  expect(screen.getByText('Building your map…')).toBeTruthy();
  expect(screen.queryByTestId('graph-screen')).toBeNull();

  await flushSettle();

  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());
  // The shared tag (≥2 bookmarks) survives, sized/labelled by its degree.
  expect(screen.getByTestId('graph-tag-t-cooking')).toBeTruthy();
  expect(screen.getByLabelText('Tag cooking, 2 bookmarks')).toBeTruthy();
  // The single-use `reading` tag is filtered out by the shared-tag backbone
  // (minSharedDegree: 2) — no hub for it.
  expect(screen.queryByTestId('graph-tag-t-reading')).toBeNull();
  // The untagged bookmark parks under the synthetic hub.
  expect(screen.getByTestId('graph-untagged-hub')).toBeTruthy();
  // Still one node per bookmark — the reading bookmark keeps its shared cooking tag.
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

// The pan is clamped so a fling can't drift the graph fully off-screen, but the
// pan is otherwise UNcaged: it's allowed until only a minimum sliver of the fitted
// content remains visible. These exercise the exact math the panResponder runs
// each frame: it clamps the ABSOLUTE position (panStart + gesture delta) into
// ±maxPanOffset(scale, viewportDim, fittedExtent), where fittedExtent is the
// per-axis on-screen span of the content at scale 1 (fitScale * viewBoxDim, fitScale
// being the preserveAspectRatio="…meet" fit = min(vw/vbW, vh/vbH)). PanResponder's
// gestureState isn't computed under the jest event pipeline (no native
// touchHistory), so we assert the bound + clamp directly.
describe('pan clamp', () => {
  // A square viewport over non-square fitted content, so the two axes take
  // genuinely different bounds. With "…meet", fitScale = min over axes; the axis
  // that hits the min FILLS the viewport, the other is letterboxed.
  const W = 400;
  const H = 400;
  const VB_W = 1000;
  const VB_H = 500;
  const fit = Math.min(W / VB_W, H / VB_H); // 0.4 — width constrains
  const extentX = fit * VB_W; // 400 — content fills the width
  const extentY = fit * VB_H; // 200 — letterboxed height

  test('at scale 1 the pan is looser than the old margin but content never fully leaves', () => {
    const maxX = maxPanOffset(1, W, extentX);
    // (400 + 400)/2 - min(400*0.15, 80) = 400 - 60 = 340.
    expect(maxX).toBe(340);
    // Bounded: less than the (extent + viewport)/2 = 400 that would push content
    // fully off-screen, so a sliver always stays visible.
    expect(maxX).toBeLessThan((extentX + W) / 2);
    // Yet looser than the old fixed ±32 margin (the "caged" feel).
    expect(maxX).toBeGreaterThan(32);
    // A huge fling is still clamped to the bound → never off-screen.
    expect(clampToRange(99999, -maxX, maxX)).toBe(340);
    expect(clampToRange(-99999, -maxX, maxX)).toBe(-340);
  });

  test('the letterboxed axis gets a tighter, content-derived bound than the filled axis', () => {
    const maxX = maxPanOffset(1, W, extentX); // filled → 340
    const maxY = maxPanOffset(1, H, extentY); // letterboxed → (200 + 400)/2 - 60 = 240
    expect(maxY).toBe(240);
    expect(maxY).toBeLessThan(maxX);
  });

  test('at MIN_SCALE the bound shrinks below the scale-1 bound but stays bounded', () => {
    const maxX = maxPanOffset(MIN_SCALE, W, extentX);
    expect(maxX).toBeLessThan(maxPanOffset(1, W, extentX));
    expect(maxX).toBeGreaterThan(0);
  });

  test('at MAX_SCALE the bound is much larger but a giant fling is still clamped', () => {
    const maxX = maxPanOffset(MAX_SCALE, W, extentX);
    // (400*6 + 400)/2 - 60 = 1400 - 60 = 1340.
    expect(maxX).toBe(1340);
    expect(maxX).toBeGreaterThan(maxPanOffset(1, W, extentX));
    // A giant drag is clamped to the axis bound, never beyond → never off-screen.
    expect(clampToRange(50000, -maxX, maxX)).toBe(1340);
    // In-range positions pass through untouched so edge nodes stay reachable.
    expect(clampToRange(200, -maxX, maxX)).toBe(200);
  });

  test('zooming in strictly widens the pan range', () => {
    expect(maxPanOffset(MAX_SCALE, W, extentX)).toBeGreaterThan(maxPanOffset(2, W, extentX));
    expect(maxPanOffset(2, W, extentX)).toBeGreaterThan(maxPanOffset(1, W, extentX));
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
