import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyticsScreenForPath } from './route.ts';

test('maps public app routes to a finite screen allowlist', () => {
  assert.equal(analyticsScreenForPath('/'), 'inbox');
  assert.equal(analyticsScreenForPath('/add'), 'add_bookmark');
  assert.equal(analyticsScreenForPath('/settings/'), 'settings');
  assert.equal(analyticsScreenForPath('/browse/tags'), 'browse_tags');
  assert.equal(analyticsScreenForPath('/bookmark/private-id'), 'bookmark_detail');
});

test('never emits auth callbacks, route parameters, queries, or unknown paths', () => {
  assert.equal(analyticsScreenForPath('/auth/callback?code=secret'), null);
  assert.equal(analyticsScreenForPath('/bookmark'), null);
  assert.equal(analyticsScreenForPath('/bookmark/private-id/edit'), null);
  assert.equal(analyticsScreenForPath('/unknown'), null);
});
