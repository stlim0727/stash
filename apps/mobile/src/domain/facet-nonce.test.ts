import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextFacetNonce } from './facet-nonce.ts';

test('nextFacetNonce yields a fresh, monotonic value each call', () => {
  // The drill-in screen is torn down by dismissTo between selections, so the
  // counter has to survive at module scope and never repeat — a fresh value on
  // every call is the whole contract the Inbox's (facet + nonce) dedupe relies
  // on (STASH-D: a repeated nonce made re-selecting the same tag a no-op).
  const first = nextFacetNonce();
  const second = nextFacetNonce();
  const third = nextFacetNonce();

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  // Strings (route params carry strings), and ordered.
  assert.equal(typeof first, 'string');
  assert.ok(Number(first) < Number(second));
  assert.ok(Number(second) < Number(third));
});
