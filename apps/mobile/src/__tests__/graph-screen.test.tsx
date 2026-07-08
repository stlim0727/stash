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

import GraphScreen, {
  anchoredPanForScale,
  clampToRange,
  graphCanvasSize,
  maxPanOffset,
  MIN_SCALE,
  MAX_SCALE,
  pinchStartSnapshot,
  touchCenterInViewport,
} from '@/app/graph';
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
// pan is otherwise UNcaged: it's allowed until only a minimum sliver of REAL NODE
// content remains visible. The bound is `maxPanOffset(scale, viewportDim,
// fittedNodeExtent)`, where fittedNodeExtent is the per-axis on-screen span of the
// drawable NODE bbox at scale 1 (fitScale * UNPADDED node span). Basing the sliver
// on the node bbox — not the padded viewBox span — is what stops a hard fling from
// parking the viewport over pure padding (a blank canvas). PanResponder's
// gestureState isn't computed under the jest event pipeline (no native
// touchHistory), so we assert the bound + clamp directly.
describe('pan clamp', () => {
  // A square viewport over a graph whose fitted NODE content is non-square, so the
  // two axes take genuinely different bounds. With "…meet" the letterboxed axis
  // gets the tighter bound.
  const W = 400;
  const H = 400;
  const MIN_VISIBLE = Math.min(W * 0.15, 80); // 60 (the sliver kept on screen)
  const extentX = 400; // fitted node span on x (fills the viewport)
  const extentY = 200; // fitted node span on y (letterboxed)

  // How much of a node bbox of the given on-screen extent stays within the
  // viewport when its center is translated |offset| px from the viewport center.
  const nodeVisible = (extent: number, offset: number) =>
    Math.max(0, extent / 2 + W / 2 - Math.abs(offset));

  test('at scale 1 the clamp keeps a MIN_VISIBLE sliver of the node on screen', () => {
    const maxX = maxPanOffset(1, W, extentX);
    // (400 + 400)/2 - 60 = 340.
    expect(maxX).toBe(340);
    // At the bound exactly MIN_VISIBLE of the node remains; one px past, it's less.
    expect(nodeVisible(extentX, maxX)).toBeCloseTo(MIN_VISIBLE);
    expect(nodeVisible(extentX, maxX + 1)).toBeLessThan(MIN_VISIBLE);
    // Looser than the old fixed ±32 margin (the "caged" feel), still bounded.
    expect(maxX).toBeGreaterThan(32);
    expect(clampToRange(99999, -maxX, maxX)).toBe(340);
    expect(clampToRange(-99999, -maxX, maxX)).toBe(-340);
  });

  test('the guarantee is NODE content, not padding — the old padded basis leaves a blank canvas', () => {
    // A small / all-untagged graph: the drawable node content is tiny, but the
    // padded viewBox (node span + VIEWBOX_PAD*2) is large. The fix feeds
    // maxPanOffset the fitted NODE extent; the OLD code fed it the fitted PADDED
    // span. This asserts the difference — and that the padded basis flings the
    // real node fully off-screen (the "hard-fling leaves empty canvas" nit).
    const fittedNodeExtent = 80; // real drawable content
    const fittedPaddedExtent = 360; // symmetric VIEWBOX_PAD inflates the span
    const boundNode = maxPanOffset(1, W, fittedNodeExtent);
    const boundPadded = maxPanOffset(1, W, fittedPaddedExtent); // old behavior
    // Node basis is strictly tighter than the padded basis.
    expect(boundNode).toBeLessThan(boundPadded);
    // New (node) basis: a real node sliver survives at the clamp limit.
    expect(nodeVisible(fittedNodeExtent, boundNode)).toBeCloseTo(MIN_VISIBLE);
    // Old (padded) basis applied to the SAME real node: it's fully off screen.
    expect(nodeVisible(fittedNodeExtent, boundPadded)).toBe(0);
  });

  test('the letterboxed axis gets a tighter bound than the filled axis', () => {
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

describe('pinch anchoring', () => {
  test('measures the pinch focal point in stable viewport coordinates', () => {
    const firstTouch = { pageX: 260, pageY: 350, locationX: 60, locationY: 70 };
    const secondTouch = { pageX: 360, pageY: 370, locationX: 90, locationY: 80 };

    expect(
      touchCenterInViewport(firstTouch, secondTouch, { x: 100, y: 200 }),
    ).toEqual({ x: 210, y: 160 });
  });

  test('keeps the viewport center fixed when pinching at the center', () => {
    expect(
      anchoredPanForScale({
        pan: { x: 30, y: -20 },
        focal: { x: 200, y: 200 },
        viewport: { w: 400, h: 400 },
        startScale: 1,
        nextScale: 2,
      }),
    ).toEqual({ x: 60, y: -40 });
  });

  test('moves pan toward the pinch focal point so that point stays under the fingers', () => {
    expect(
      anchoredPanForScale({
        pan: { x: 0, y: 0 },
        focal: { x: 300, y: 100 },
        viewport: { w: 400, h: 400 },
        startScale: 1,
        nextScale: 2,
      }),
    ).toEqual({ x: -100, y: 100 });
  });

  test('starts a pinch from the live pan after a one-finger drag', () => {
    expect(
      pinchStartSnapshot({
        touches: [
          { pageX: 150, pageY: 160 },
          { pageX: 250, pageY: 160 },
        ],
        lastScale: 1.4,
        panOffset: { x: 20, y: 10 },
        containerOrigin: { x: 0, y: 0 },
      }),
    ).toMatchObject({
      startDist: 100,
      startScale: 1.4,
      startPan: { x: 20, y: 10 },
      startFocal: { x: 200, y: 160 },
    });
  });
});

describe('graph canvas sizing', () => {
  test('uses the measured container when layout has reported a size', () => {
    expect(graphCanvasSize({ w: 640, h: 480 }, { width: 1440, height: 900 })).toEqual({
      w: 640,
      h: 480,
    });
  });

  test('falls back to the browser window instead of a phone-sized canvas before layout', () => {
    expect(graphCanvasSize({ w: 0, h: 0 }, { width: 1440, height: 900 })).toEqual({
      w: 1440,
      h: 900,
    });
  });

  test('keeps the small hard fallback only when neither layout nor window size exists', () => {
    expect(graphCanvasSize({ w: 0, h: 0 }, { width: 0, height: 0 })).toEqual({
      w: 320,
      h: 320,
    });
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

// Co-occurrence mode: two tags that co-occur on ≥2 bookmarks form a qualifying
// tag–tag edge, so both become tag nodes (no bookmark nodes, no untagged hub).
function seedCoOccurring() {
  const one = '7e64cf1e-0000-4000-8000-0000000000c1';
  const two = '7e64cf1e-0000-4000-8000-0000000000c2';
  const at = '2026-06-12T00:00:00.000Z';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: one, title: 'First' }),
      makeStoredBookmark({ id: two, title: 'Second' }),
    ],
    {
      tags: [makeTag('t-alpha', 'alpha'), makeTag('t-beta', 'beta')],
      bookmarkTags: [
        { bookmark_id: one, tag_id: 't-alpha', source: 'user', confidence: null, created_at: at },
        { bookmark_id: one, tag_id: 't-beta', source: 'user', confidence: null, created_at: at },
        { bookmark_id: two, tag_id: 't-alpha', source: 'user', confidence: null, created_at: at },
        { bookmark_id: two, tag_id: 't-beta', source: 'user', confidence: null, created_at: at },
      ],
      collections: [],
    },
  );
}

test('switching to co-occurrence renders tag-only nodes, drops bookmark nodes, and still facets on tap', async () => {
  seedCoOccurring();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  // Bipartite first (the default): bookmark nodes are present.
  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000c1')).toBeTruthy();

  // Toggle to co-occurrence: the mode change re-settles off the render path, so
  // the loading state paints first, then we flush the new settle.
  await fireEvent.press(screen.getByTestId('graph-mode-cooccurrence'));
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  // Tags-only graph: both co-occurring tags are nodes; no bookmark nodes remain.
  await waitFor(() => expect(screen.getByTestId('graph-tag-t-alpha')).toBeTruthy());
  expect(screen.getByTestId('graph-tag-t-beta')).toBeTruthy();
  expect(screen.queryByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000c1')).toBeNull();
  expect(screen.queryByTestId('graph-untagged-hub')).toBeNull();

  // Tapping a tag still hands the facet to the root Inbox.
  await fireEvent.press(screen.getByTestId('graph-tag-t-alpha'));
  expect(mockDismissTo).toHaveBeenCalledTimes(1);
  expect(mockDismissTo.mock.calls[0][0].params.tag).toBe('t-alpha');
});

test('co-occurrence with no qualifying tag-pairs shows an intentional empty state, not a blank canvas', async () => {
  // seedLibrary's only shared pair (cooking, reading) co-occurs on ONE bookmark,
  // below the ≥2 threshold → the co-occurrence graph derives no nodes.
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('graph-mode-cooccurrence'));
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  // The "no shared tags yet" hint surfaces and the toggle stays reachable so the
  // user can switch back — never a bare blank canvas.
  await waitFor(() => expect(screen.getByText('No shared tags yet')).toBeTruthy());
  expect(screen.getByTestId('graph-mode-bipartite')).toBeTruthy();
  expect(screen.queryByTestId('graph-tag-t-cooking')).toBeNull();
});
