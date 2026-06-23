import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bookmark } from '@/domain/types';
import {
  MONOGRAM_COLORS,
  hostFromUrl,
  itemIcon,
  monogramColorIndex,
  monogramIcon,
} from './item-icon.ts';

function make(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u',
    url: 'https://www.example.com/x',
    canonical_url: null,
    url_hash: null,
    title: null,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  } as Bookmark;
}

test('uses the favicon when present', () => {
  const icon = itemIcon(make({ favicon_url: 'https://cdn/f.png' }));
  assert.deepEqual(icon, { kind: 'favicon', uri: 'https://cdn/f.png' });
});

test('blank favicon is ignored (falls back to monogram)', () => {
  const icon = itemIcon(make({ favicon_url: '   ' }));
  assert.equal(icon.kind, 'monogram');
});

test('monogramIcon ignores any favicon — the on-device load-error fallback', () => {
  // Even with a favicon present, monogramIcon yields the colored-letter variant
  // so a 404'd favicon can fall back to it without leaving a blank tile.
  const icon = monogramIcon(make({ favicon_url: 'https://cdn/f.png', site_name: 'Raindrop' }));
  assert.equal(icon.kind, 'monogram');
  assert.equal(icon.letter, 'R');
});

test('hostFromUrl strips www and handles bad input', () => {
  assert.equal(hostFromUrl('https://www.example.com/x'), 'example.com');
  assert.equal(hostFromUrl('https://docs.expo.dev/a'), 'docs.expo.dev');
  assert.equal(hostFromUrl(null), null);
  assert.equal(hostFromUrl('not a url'), null);
});

test('monogram letter prefers site name, then domain, then title', () => {
  assert.equal(itemIcon(make({ site_name: 'Raindrop' })).kind, 'monogram');
  assert.equal((itemIcon(make({ site_name: 'Raindrop' })) as { letter: string }).letter, 'R');
  // no site name → domain (example.com → E)
  assert.equal((itemIcon(make()) as { letter: string }).letter, 'E');
  // no site name, no url → title
  assert.equal(
    (itemIcon(make({ url: null, title: 'zeta note' })) as { letter: string }).letter,
    'Z',
  );
});

test('letter skips leading non-alphanumerics and uppercases', () => {
  assert.equal((itemIcon(make({ url: null, title: '  -·9lives' })) as { letter: string }).letter, '9');
  assert.equal(
    (itemIcon(make({ url: null, title: '###', site_name: null })) as { letter: string }).letter,
    '#',
  );
});

test('monogram color is deterministic and within range', () => {
  const idx = monogramColorIndex('example.com');
  assert.equal(idx, monogramColorIndex('example.com'));
  assert.ok(idx >= 0 && idx < MONOGRAM_COLORS.length);
});

test('same site keeps its color regardless of www / path', () => {
  const a = itemIcon(make({ url: 'https://www.example.com/a' })) as { colorIndex: number };
  const b = itemIcon(make({ url: 'https://example.com/b/c?q=1' })) as { colorIndex: number };
  assert.equal(a.colorIndex, b.colorIndex);
});
