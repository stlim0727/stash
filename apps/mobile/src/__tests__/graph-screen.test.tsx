import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { InteractionManager, Pressable, Text, processColor } from 'react-native';

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
  bakeViewBox,
  clampToRange,
  graphCanvasSize,
  maxPanOffset,
  MIN_SCALE,
  MAX_SCALE,
  panWithPinchFocalDelta,
  pinchStartSnapshot,
  touchCenterInViewport,
  truncateGraphLabel,
  wheelZoomScale,
} from '@/app/graph';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { Tag } from '@/domain/types';
import { palettes } from '@/theme';
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

// Fires a title-only edit through the same store the screen reads from, so a
// test can exercise "the bookmark's title changed without any tag change" —
// the case where the settled graph's cached `label` goes stale.
function EditTitleTrigger({ id, title }: { id: string; title: string }) {
  const { updateBookmarkFields } = useBookmarks();
  return (
    <Pressable testID="edit-title-trigger" onPress={() => updateBookmarkFields(id, { title })}>
      <Text>edit</Text>
    </Pressable>
  );
}

function renderScreenWithEditTrigger(id: string, newTitle: string) {
  return render(
    <BookmarksProvider>
      <GraphScreen />
      <EditTitleTrigger id={id} title={newTitle} />
    </BookmarksProvider>,
  );
}

function collectNodesWithProp(
  node: unknown,
  propName: string,
  found: Array<{ props: Record<string, unknown> }> = [],
) {
  if (!node || typeof node !== 'object') {
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectNodesWithProp(child, propName, found));
    return found;
  }
  const current = node as { props?: Record<string, unknown>; children?: unknown };
  if (current.props && propName in current.props) {
    found.push({ props: current.props });
  }
  collectNodesWithProp(current.children, propName, found);
  return found;
}

// react-native-svg splits a <Text> with a string child across two native
// nodes: the outer RNSVGText carries `pointerEvents`, while the actual
// rendered string lands on a nested RNSVGTSpan's `content` prop (see
// collectNodesWithProp usage elsewhere in this file). This walks the tree and
// pairs each RNSVGText's pointerEvents with its descendant TSpan's content.
function collectSvgTextNodes(
  node: unknown,
): Array<{ pointerEvents: unknown; content: string | null }> {
  const found: Array<{ pointerEvents: unknown; content: string | null }> = [];
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') {
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const current = n as { type?: string; props?: Record<string, unknown>; children?: unknown };
    if (current.type === 'RNSVGText') {
      const tspanContents = collectNodesWithProp(current.children, 'content')
        .map((tspan) => tspan.props.content)
        .filter((content): content is string => typeof content === 'string');
      found.push({
        pointerEvents: current.props?.pointerEvents,
        content: tspanContents[0] ?? null,
      });
    }
    visit(current.children);
  };
  visit(node);
  return found;
}

function nativeColorPayload(value: unknown) {
  if (value && typeof value === 'object' && 'payload' in value) {
    return (value as { payload: unknown }).payload;
  }
  return value;
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
// shared `cooking` tag), plus an untagged bookmark that is omitted from the graph.
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

test('renders the shared-tag backbone and omits untagged bookmarks', async () => {
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
  // The untagged bookmark is omitted from the graph.
  expect(screen.queryByTestId('graph-untagged-hub')).toBeNull();
  // Tagged bookmarks still render; the reading bookmark keeps its shared cooking tag.
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a1')).toBeTruthy();
  expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a2')).toBeTruthy();
  expect(screen.queryByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000a3')).toBeNull();
});

test('renders graph edges with readable contrast', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());
  const edges = collectNodesWithProp(screen.toJSON(), 'strokeOpacity');
  expect(edges.length).toBeGreaterThan(0);
  const expectedStroke = nativeColorPayload(processColor(palettes.light.textSecondary));
  for (const edge of edges) {
    expect(nativeColorPayload(edge.props.stroke)).toEqual(expectedStroke);
    expect(edge.props.strokeOpacity).toBeGreaterThanOrEqual(0.7);
  }
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

describe('truncateGraphLabel', () => {
  test('leaves short text untouched', () => {
    expect(truncateGraphLabel('Kimchi jjigae', 18)).toBe('Kimchi jjigae');
  });

  test('trims trailing/leading whitespace even when under the cap', () => {
    expect(truncateGraphLabel('  Local-first  ', 18)).toBe('Local-first');
  });

  test('caps long text with an ellipsis, at or under the cap length', () => {
    const truncated = truncateGraphLabel('A genuinely very long bookmark title indeed', 18);
    expect(truncated).toBe('A genuinely very…');
    expect(truncated.length).toBeLessThanOrEqual(18);
    expect(truncated.endsWith('…')).toBe(true);
  });
});

test('bookmark nodes render a length-capped title label', async () => {
  // Two bookmarks share `cooking` so it survives the shared-tag backbone
  // (minSharedDegree: 2) and both bookmark nodes render.
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-0000000000d1',
        title: 'A genuinely very long bookmark title that should be truncated',
      }),
      makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000d2', title: 'Short one' }),
    ],
    {
      tags: [makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        {
          bookmark_id: '7e64cf1e-0000-4000-8000-0000000000d1',
          tag_id: 't-cooking',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
        {
          bookmark_id: '7e64cf1e-0000-4000-8000-0000000000d2',
          tag_id: 't-cooking',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [],
    },
  );

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  await waitFor(() =>
    expect(screen.getByTestId('graph-bookmark-7e64cf1e-0000-4000-8000-0000000000d1')).toBeTruthy(),
  );
  // react-native-svg's Text renders its string child into a nested TSpan's
  // `content` prop, not an RN-visible text node, so RNTL's getByText can't see
  // it — read the rendered label content directly off the tree instead.
  const labelContents = collectNodesWithProp(screen.toJSON(), 'content')
    .map((node) => node.props.content)
    .filter((content): content is string => typeof content === 'string');
  // The full title is truncated to the cap with an ellipsis, not shown in full.
  expect(labelContents).toContain('A genuinely very…');
  expect(labelContents).not.toContain(
    'A genuinely very long bookmark title that should be truncated',
  );
  // A short title renders untouched.
  expect(labelContents).toContain('Short one');
});

test('bookmark labels ignore pointer events so an overlapping label never blocks a tap', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());

  const textNodes = collectSvgTextNodes(screen.toJSON());
  // seedLibrary's two tagged bookmarks ("Kimchi jjigae", "Local-first
  // software") get pointer-transparent labels so an overlapping label can
  // never steal a tap meant for the circle beneath it. "Local-first software"
  // is over the 18-char cap, so match its truncated form (same helper the
  // screen itself renders through).
  const bookmarkLabelNodes = textNodes.filter((node) =>
    [truncateGraphLabel('Kimchi jjigae', 18), truncateGraphLabel('Local-first software', 18)].includes(
      node.content ?? '',
    ),
  );
  expect(bookmarkLabelNodes).toHaveLength(2);
  for (const node of bookmarkLabelNodes) {
    expect(node.pointerEvents).toBe('none');
  }
  // The tag hub label is unrelated to this fix and keeps its default (it
  // isn't the tap target either way — the hub circle sits under it).
  const hubLabelNode = textNodes.find((node) => node.content === 'cooking');
  expect(hubLabelNode?.pointerEvents).not.toBe('none');
});

test('a title-only edit updates the bookmark label without a tag-topology change', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e1';
  const other = '7e64cf1e-0000-4000-8000-0000000000e2';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id, title: 'Original title' }),
      makeStoredBookmark({ id: other, title: 'Other bookmark' }),
    ],
    {
      tags: [makeTag('t-cooking', 'cooking')],
      bookmarkTags: [
        {
          bookmark_id: id,
          tag_id: 't-cooking',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
        {
          bookmark_id: other,
          tag_id: 't-cooking',
          source: 'user',
          confidence: null,
          created_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      collections: [],
    },
  );

  const screen = await renderScreenWithEditTrigger(id, 'Renamed title');
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();
  await waitFor(() => expect(screen.getByTestId(`graph-bookmark-${id}`)).toBeTruthy());

  const labelContentsBefore = collectNodesWithProp(screen.toJSON(), 'content')
    .map((node) => node.props.content)
    .filter((content): content is string => typeof content === 'string');
  expect(labelContentsBefore).toContain('Original title');

  await act(async () => {
    fireEvent.press(screen.getByTestId('edit-title-trigger'));
  });

  // The tag topology is unchanged, so this must NOT re-enter the loading
  // state (no resettle) — the label updates in place.
  expect(screen.queryByTestId('graph-loading')).toBeNull();
  const labelContentsAfter = collectNodesWithProp(screen.toJSON(), 'content')
    .map((node) => node.props.content)
    .filter((content): content is string => typeof content === 'string');
  expect(labelContentsAfter).toContain('Renamed title');
  expect(labelContentsAfter).not.toContain('Original title');
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

test('keeps pan responder on the canvas layer, not the overlay parent', async () => {
  seedLibrary();

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  const graph = await waitFor(() => screen.getByTestId('graph-screen'));
  const canvas = screen.getByTestId('graph-canvas');
  expect(graph.props.onMoveShouldSetResponder).toBeUndefined();
  expect(canvas.props.onMoveShouldSetResponder).toEqual(expect.any(Function));
  expect(screen.getByTestId('graph-mode-cooccurrence')).toBeTruthy();
  expect(screen.getByTestId('graph-recenter')).toBeTruthy();
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

  test('adds two-finger focal movement so pinching can pan sideways', () => {
    const anchored = anchoredPanForScale({
      pan: { x: 0, y: 0 },
      focal: { x: 200, y: 200 },
      viewport: { w: 400, h: 400 },
      startScale: 1,
      nextScale: 2,
    });

    expect(
      panWithPinchFocalDelta({
        anchoredPan: anchored,
        startFocal: { x: 200, y: 200 },
        currentFocal: { x: 250, y: 180 },
      }),
    ).toEqual({ x: 50, y: -20 });
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

// The web-only wheel listener drives an Animated transform through native DOM
// APIs (see the effect in app/graph.tsx), which the jest-expo test renderer
// doesn't provide — same reason the pinch gesture above is asserted through its
// pure math rather than a simulated touch stream. wheelZoomScale is that math
// for the wheel path: it decides the NEXT scale from a raw `deltaY`; the
// resulting pan gets anchored on the cursor via the same anchoredPanForScale
// tested above.
describe('wheel zoom', () => {
  test('scrolling up (negative deltaY) zooms in', () => {
    expect(wheelZoomScale(1, -100)).toBeGreaterThan(1);
  });

  test('scrolling down (positive deltaY) zooms out', () => {
    expect(wheelZoomScale(1, 100)).toBeLessThan(1);
  });

  test('a zero delta leaves the scale unchanged', () => {
    expect(wheelZoomScale(2, 0)).toBe(2);
  });

  test('clamps zoom-in at MAX_SCALE instead of overshooting', () => {
    expect(wheelZoomScale(MAX_SCALE, -100000)).toBe(MAX_SCALE);
  });

  test('clamps zoom-out at MIN_SCALE instead of overshooting', () => {
    expect(wheelZoomScale(MIN_SCALE, 100000)).toBe(MIN_SCALE);
  });
});

// STASH-2N/STASH-2R: pinch-zoom used to be ONLY a CSS-style transform over a
// fixed-resolution SVG, which is why bookmark-label text stayed visibly
// blurred at high zoom even after a gesture settled — the underlying picture
// was never redrawn at the new resolution. `bakeViewBox` computes a new
// viewBox that, rendered with an IDENTITY transform, reproduces the exact
// same on-screen content as the OLD system's `base` viewBox + `pan`/`scale`
// transform — so the graph screen can reset the transform to identity after
// baking and get a freshly-rendered (crisp) picture at the committed zoom,
// with no visible jump. This independently re-derives the OLD system's
// screen mapping (transform: translate ∘ scale-around-viewport-center, same
// model `anchoredPanForScale` above already relies on) and asserts it agrees
// with the NEW system (baked viewBox, identity transform) for sample points.
describe('bake viewBox', () => {
  function oldSystemScreenPoint(
    point: { x: number; y: number },
    base: { minX: number; minY: number; w: number; h: number },
    viewport: { w: number; h: number },
    pan: { x: number; y: number },
    scale: number,
  ) {
    const fit = Math.min(viewport.w / base.w, viewport.h / base.h);
    const offsetX = (viewport.w - base.w * fit) / 2;
    const offsetY = (viewport.h - base.h * fit) / 2;
    const preTransformX = offsetX + (point.x - base.minX) * fit;
    const preTransformY = offsetY + (point.y - base.minY) * fit;
    return {
      x: viewport.w / 2 + scale * (preTransformX - viewport.w / 2) + pan.x,
      y: viewport.h / 2 + scale * (preTransformY - viewport.h / 2) + pan.y,
    };
  }

  function newSystemScreenPoint(
    point: { x: number; y: number },
    baked: { minX: number; minY: number; w: number; h: number },
    viewport: { w: number; h: number },
  ) {
    return oldSystemScreenPoint(point, baked, viewport, { x: 0, y: 0 }, 1);
  }

  test('a no-op bake (scale 1, pan {0,0}) returns the base unchanged', () => {
    const base = { minX: -20, minY: -10, w: 400, h: 300 };
    expect(
      bakeViewBox({ base, viewport: { w: 800, h: 600 }, pan: { x: 0, y: 0 }, scale: 1 }),
    ).toEqual(base);
  });

  test('the baked identity view reproduces the same screen mapping as the original transform (zoomed in, panned, letterboxed)', () => {
    const base = { minX: 0, minY: 0, w: 1000, h: 500 }; // wider than the 800x600 viewport → letterboxed on Y
    const viewport = { w: 800, h: 600 };
    const pan = { x: 37, y: -52 };
    const scale = 2.5;

    const baked = bakeViewBox({ base, viewport, pan, scale });
    const samplePoints = [
      { x: 0, y: 0 },
      { x: 1000, y: 500 },
      { x: 500, y: 250 }, // center
      { x: 120, y: 480 },
      { x: 900, y: 30 },
    ];
    for (const point of samplePoints) {
      const before = oldSystemScreenPoint(point, base, viewport, pan, scale);
      const after = newSystemScreenPoint(point, baked, viewport);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  test('reproduces the same mapping when zoomed OUT (scale < 1)', () => {
    const base = { minX: -100, minY: -100, w: 600, h: 800 }; // taller → letterboxed on X
    const viewport = { w: 500, h: 500 };
    const pan = { x: -15, y: 8 };
    const scale = 0.6;

    const baked = bakeViewBox({ base, viewport, pan, scale });
    const point = { x: 260, y: -40 };
    const before = oldSystemScreenPoint(point, base, viewport, pan, scale);
    const after = newSystemScreenPoint(point, baked, viewport);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  test('baking twice in a row (successive gestures) composes correctly', () => {
    const base = { minX: 0, minY: 0, w: 1200, h: 900 };
    const viewport = { w: 900, h: 700 };
    const firstPan = { x: 40, y: -10 };
    const firstScale = 1.8;

    const afterFirst = bakeViewBox({ base, viewport, pan: firstPan, scale: firstScale });

    const secondPan = { x: -25, y: 30 };
    const secondScale = 1.4;
    const afterSecond = bakeViewBox({ base: afterFirst, viewport, pan: secondPan, scale: secondScale });

    // The combined effect of both bakes must equal replaying the two
    // transforms directly against the ORIGINAL base (each one anchored on
    // the viewport center in turn, same as two real successive gestures on
    // the Animated transform stack) — a chain of gestures shouldn't drift
    // from that "ground truth" composed result.
    const point = { x: 300, y: 600 };
    const viaTwoBakes = newSystemScreenPoint(point, afterSecond, viewport);
    const direct = composeTwoTransforms(point, base, viewport, firstPan, firstScale, secondPan, secondScale);
    expect(viaTwoBakes.x).toBeCloseTo(direct.x, 6);
    expect(viaTwoBakes.y).toBeCloseTo(direct.y, 6);
  });

  // Applies transform 1 then transform 2 directly against `base`, composing
  // them the way two successive gestures would on the real Animated
  // transform stack (each anchored on the viewport center in turn) — an
  // independent route to the "two settled gestures" result that never goes
  // through `bakeViewBox`, for the chained-bake test above to check against.
  function composeTwoTransforms(
    point: { x: number; y: number },
    base: { minX: number; minY: number; w: number; h: number },
    viewport: { w: number; h: number },
    pan1: { x: number; y: number },
    scale1: number,
    pan2: { x: number; y: number },
    scale2: number,
  ) {
    const afterFirstScreen = oldSystemScreenPoint(point, base, viewport, pan1, scale1);
    return {
      x: viewport.w / 2 + scale2 * (afterFirstScreen.x - viewport.w / 2) + pan2.x,
      y: viewport.h / 2 + scale2 * (afterFirstScreen.y - viewport.h / 2) + pan2.y,
    };
  }
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

test('an all-untagged stash shows the add-tags hint without drawing an untagged cluster', async () => {
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000b1', title: 'Loose one' })],
    { tags: [], bookmarkTags: [], collections: [] },
  );

  const screen = await renderScreen();
  await waitFor(() => expect(screen.getByTestId('graph-loading')).toBeTruthy());
  await flushSettle();

  await waitFor(() => expect(screen.getByTestId('graph-screen')).toBeTruthy());
  expect(screen.queryByTestId('graph-untagged-hub')).toBeNull();
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
