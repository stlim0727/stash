/**
 * A live snapshot of the Inbox hero/collapsing-header render state, written by
 * `InboxScreen` on every relevant state change and read once when a feedback
 * report is opened (`FloatingReportButton`). Every prior "hero not visible"
 * Sentry report (STASH-1X, STASH-2G, STASH-2P) arrived with `screenshot:
 * absent` and no capture of this state, so root cause had to be guessed from
 * sync/auth logs alone. This gives the next report a direct, timely read of
 * what the hero was actually doing, without waiting on the screenshot capture
 * (which can itself race the report-open timeout under heavy sync load).
 */

export interface HeroDiagnosticsSnapshot {
  collapsed: boolean;
  heroHeight: number;
  collapsibleHeight: number;
  wordmarkLoaded: boolean;
  wordmarkFailed: boolean;
  showWordmarkFallback: boolean;
}

interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementPaintSnapshot {
  tag: string;
  testId: string | null;
  connected: boolean;
  rect: RectSnapshot;
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  zIndex: string;
  transform: string;
  overflow: string;
  pointerEvents: string;
  clipPath: string;
  filter: string;
  backgroundColor: string;
  backgroundImage: 'none' | 'present';
}

export interface HeroDomDiagnostics {
  available: boolean;
  reason?: 'dom-unavailable' | 'hero-not-found' | 'probe-failed';
  errorName?: string;
  visibilityState?: string;
  viewport?: {
    width: number;
    height: number;
    devicePixelRatio: number;
    prefersDark: boolean | null;
  };
  header?: ElementPaintSnapshot | null;
  hero?: ElementPaintSnapshot | null;
  imageWrapper?: ElementPaintSnapshot | null;
  backgroundLayer?: ElementPaintSnapshot | null;
  imageResource?: {
    assetName: string | null;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
  } | null;
  centerStack?: Array<{ tag: string; testId: string | null }>;
  heroOwnsTopPoint?: boolean;
}

interface HeroDomEnvironment {
  document: Document | null;
  window: Window | null;
  getComputedStyle: ((element: Element) => CSSStyleDeclaration) | null;
}

function roundedRect(element: Element): RectSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function paintSnapshot(
  element: Element | null,
  styleFor: (element: Element) => CSSStyleDeclaration,
): ElementPaintSnapshot | null {
  if (!element) {
    return null;
  }
  const style = styleFor(element);
  return {
    tag: element.tagName.toLowerCase(),
    testId: element.getAttribute('data-testid'),
    connected: element.isConnected,
    rect: roundedRect(element),
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    position: style.position,
    zIndex: style.zIndex,
    transform: style.transform,
    overflow: style.overflow,
    pointerEvents: style.pointerEvents,
    clipPath: style.clipPath,
    filter: style.filter,
    backgroundColor: style.backgroundColor,
    backgroundImage:
      style.backgroundImage && style.backgroundImage !== 'none' ? 'present' : 'none',
  };
}

function assetName(src: string): string | null {
  if (!src) {
    return null;
  }
  try {
    const pathname = new URL(src, 'https://keepory.invalid').pathname;
    return pathname.split('/').filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Captures the browser's actual paint inputs at the instant feedback opens.
 * It intentionally records only geometry/style/resource shape — never page
 * text, URLs, or image bytes — so it is safe to include in diagnostics.logs.
 */
export function collectHeroDomDiagnostics(environment: HeroDomEnvironment): HeroDomDiagnostics {
  const { document: documentObject, window: windowObject, getComputedStyle: styleFor } =
    environment;
  if (!documentObject || !windowObject || !styleFor) {
    return { available: false, reason: 'dom-unavailable' };
  }

  const hero = documentObject.querySelector('[data-testid="inbox-hero-wordmark"]');
  if (!hero) {
    return { available: false, reason: 'hero-not-found' };
  }

  const header = documentObject.querySelector('[data-testid="inbox-header-surface"]');
  const imageWrapper = documentObject.querySelector('[data-testid="inbox-wordmark-image"]');
  const backgroundLayer = imageWrapper?.querySelector('div[style*="background-image"]') ?? null;
  const image = imageWrapper?.querySelector('img') as HTMLImageElement | null;
  const heroRect = hero.getBoundingClientRect();
  const centerX = heroRect.x + heroRect.width / 2;
  const centerY = heroRect.y + heroRect.height / 2;
  const centerStack = documentObject.elementsFromPoint?.(centerX, centerY) ?? [];

  let prefersDark: boolean | null = null;
  try {
    prefersDark = windowObject.matchMedia?.('(prefers-color-scheme: dark)').matches ?? null;
  } catch {
    // A locked-down browser may deny matchMedia; the rest of the probe is useful.
  }

  return {
    available: true,
    visibilityState: documentObject.visibilityState,
    viewport: {
      width: windowObject.innerWidth,
      height: windowObject.innerHeight,
      devicePixelRatio: windowObject.devicePixelRatio,
      prefersDark,
    },
    header: paintSnapshot(header, styleFor),
    hero: paintSnapshot(hero, styleFor),
    imageWrapper: paintSnapshot(imageWrapper, styleFor),
    backgroundLayer: paintSnapshot(backgroundLayer, styleFor),
    imageResource: image
      ? {
          assetName: assetName(image.currentSrc || image.src),
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        }
      : null,
    centerStack: centerStack.slice(0, 6).map((element) => ({
      tag: element.tagName.toLowerCase(),
      testId: element.getAttribute('data-testid'),
    })),
    heroOwnsTopPoint: centerStack.length > 0 ? hero.contains(centerStack[0]) : false,
  };
}

export function getHeroDomDiagnostics(): HeroDomDiagnostics {
  try {
    return collectHeroDomDiagnostics({
      document: typeof document === 'object' ? document : null,
      window: typeof window === 'object' ? window : null,
      getComputedStyle:
        typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle : null,
    });
  } catch (error) {
    return {
      available: false,
      reason: 'probe-failed',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}

let snapshot: HeroDiagnosticsSnapshot | null = null;

export function setHeroDiagnosticsSnapshot(next: HeroDiagnosticsSnapshot | null): void {
  snapshot = next;
}

export function getHeroDiagnosticsSnapshot(): HeroDiagnosticsSnapshot | null {
  return snapshot;
}
