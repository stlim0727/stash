import assert from 'node:assert/strict';
import test from 'node:test';

import { collectHeroDomDiagnostics } from '@/feedback/hero-diagnostics-session';

interface FakeElement {
  tagName: string;
  isConnected: boolean;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
  querySelector: (selector: string) => FakeElement | null;
  contains: (candidate: unknown) => boolean;
  children: Map<string, FakeElement>;
}

function element(
  tagName: string,
  testId: string | null,
  rect: { x: number; y: number; width: number; height: number },
): FakeElement {
  const children = new Map<string, FakeElement>();
  const value: FakeElement = {
    tagName,
    isConnected: true,
    getAttribute: (name: string) => (name === 'data-testid' ? testId : null),
    getBoundingClientRect: () => rect,
    querySelector: (selector: string) => children.get(selector) ?? null,
    contains: (candidate: unknown) => candidate === value || [...children.values()].includes(candidate as never),
    children,
  };
  return value;
}

test('collectHeroDomDiagnostics records paint shape without page text or full URLs', () => {
  const header = element('DIV', 'inbox-header-surface', { x: 0, y: 0, width: 1200, height: 52 });
  const hero = element('BUTTON', 'inbox-hero-wordmark', { x: 20, y: 12, width: 120, height: 28 });
  const wrapper = element('DIV', 'inbox-wordmark-image', { x: 20, y: 12, width: 120, height: 28 });
  const background = element('DIV', null, { x: 20, y: 12, width: 120, height: 28 });
  const image = {
    ...element('IMG', null, { x: 20, y: 12, width: 120, height: 28 }),
    currentSrc: 'https://keepory.app/assets/wordmark.hash.png?private=query',
    src: '',
    complete: true,
    naturalWidth: 1375,
    naturalHeight: 322,
  };
  wrapper.children.set('div[style*="background-image"]', background);
  wrapper.children.set('img', image);
  hero.children.set('image', wrapper);

  const selectors = new Map<string, unknown>([
    ['[data-testid="inbox-header-surface"]', header],
    ['[data-testid="inbox-hero-wordmark"]', hero],
    ['[data-testid="inbox-wordmark-image"]', wrapper],
  ]);
  const documentObject = {
    visibilityState: 'visible',
    querySelector: (selector: string) => selectors.get(selector) ?? null,
    elementsFromPoint: () => [wrapper, hero, header],
  };
  const windowObject = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: true }),
  };
  const style = {
    display: 'flex',
    visibility: 'visible',
    opacity: '1',
    position: 'relative',
    zIndex: '0',
    transform: 'none',
    overflow: 'hidden',
    pointerEvents: 'auto',
    clipPath: 'none',
    filter: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'url("https://keepory.app/assets/wordmark.hash.png?private=query")',
  };

  const result = collectHeroDomDiagnostics({
    document: documentObject as unknown as Document,
    window: windowObject as unknown as Window,
    getComputedStyle: (() => style) as unknown as typeof getComputedStyle,
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.viewport, {
    width: 1200,
    height: 800,
    devicePixelRatio: 2,
    prefersDark: true,
  });
  assert.equal(result.hero?.rect.height, 28);
  assert.equal(result.hero?.backgroundImage, 'present');
  assert.equal(result.imageResource?.assetName, 'wordmark.hash.png');
  assert.equal(result.imageResource?.naturalWidth, 1375);
  assert.deepEqual(result.centerStack, [
    { tag: 'div', testId: 'inbox-wordmark-image' },
    { tag: 'button', testId: 'inbox-hero-wordmark' },
    { tag: 'div', testId: 'inbox-header-surface' },
  ]);
  assert.equal(result.heroOwnsTopPoint, true);
  assert.equal(JSON.stringify(result).includes('private=query'), false);
});

test('collectHeroDomDiagnostics reports unavailable DOM without throwing', () => {
  assert.deepEqual(
    collectHeroDomDiagnostics({ document: null, window: null, getComputedStyle: null }),
    { available: false, reason: 'dom-unavailable' },
  );
});
