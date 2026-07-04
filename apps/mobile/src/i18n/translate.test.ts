import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en } from './messages.ts';
import { ko } from './ko.ts';
import { createT, formatNumber } from './translate.ts';

test('returns the locale string for a known key', () => {
  const t = createT('ko');
  assert.equal(t('common.cancel'), '취소');
});

test('interpolates named placeholders', () => {
  const t = createT('en');
  assert.equal(t('inbox.inCollection', { name: 'Recipes' }), 'in Recipes');
});

test('falls back to English when the locale lacks a key', () => {
  // Construct a key present in English; if Korean ever drops it, English shows.
  const t = createT('ko');
  // 'app.name' is intentionally not in the ko catalog (brand name).
  assert.equal(t('app.name'), 'Keepory');
});

test('English plural selects one vs other by count', () => {
  const t = createT('en');
  assert.equal(t('settings.sync.waiting', { count: 1 }), '1 item waiting to upload');
  assert.equal(t('settings.sync.waiting', { count: 3 }), '3 items waiting to upload');
});

test('Korean plural always uses the other variant', () => {
  const t = createT('ko');
  assert.equal(t('settings.sync.waiting', { count: 1 }), '1개 항목 업로드 대기 중');
  assert.equal(t('settings.sync.waiting', { count: 5 }), '5개 항목 업로드 대기 중');
});

test('unknown key returns the key itself (visible, never blank)', () => {
  const t = createT('en');
  // @ts-expect-error — exercising the runtime fallback for an unknown key.
  assert.equal(t('does.not.exist'), 'does.not.exist');
});

test('formatNumber respects the locale', () => {
  assert.equal(formatNumber(1234, 'en'), '1,234');
});

test('every Korean key exists in the English source catalog', () => {
  for (const key of Object.keys(ko)) {
    assert.ok(key in en, `ko has a key missing from en: ${key}`);
  }
});

test('Korean plural entries provide the required other variant', () => {
  for (const [key, value] of Object.entries(ko)) {
    if (value && typeof value === 'object') {
      assert.equal(typeof value.other, 'string', `${key} must define other`);
    }
  }
});
