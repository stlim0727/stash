import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  isSupportedLocale,
  parseLocalePreference,
  resolveLocaleFromTags,
  resolvePreference,
  serializeLocalePreference,
  type LocalePreference,
} from './locale.ts';

test('isSupportedLocale only accepts shipped locales', () => {
  assert.equal(isSupportedLocale('en'), true);
  assert.equal(isSupportedLocale('ko'), true);
  assert.equal(isSupportedLocale('fr'), false);
  assert.equal(isSupportedLocale(null), false);
  assert.equal(isSupportedLocale(undefined), false);
});

test('parse/serialize round-trips and falls back to the default', () => {
  const prefs: LocalePreference[] = ['system', 'en', 'ko'];
  for (const pref of prefs) {
    assert.equal(parseLocalePreference(serializeLocalePreference(pref)), pref);
  }
  assert.equal(parseLocalePreference(null), DEFAULT_LOCALE_PREFERENCE);
  assert.equal(parseLocalePreference('garbage'), DEFAULT_LOCALE_PREFERENCE);
});

test('resolveLocaleFromTags matches the primary subtag, English otherwise', () => {
  assert.equal(resolveLocaleFromTags(['ko-KR', 'en-US']), 'ko');
  assert.equal(resolveLocaleFromTags(['en-GB']), 'en');
  assert.equal(resolveLocaleFromTags(['fr-FR', 'de']), DEFAULT_LOCALE);
  assert.equal(resolveLocaleFromTags([null, undefined]), DEFAULT_LOCALE);
  // First supported tag wins (device preference order).
  assert.equal(resolveLocaleFromTags(['fr', 'ko']), 'ko');
});

test('resolvePreference follows the device only for system', () => {
  assert.equal(resolvePreference('system', 'ko'), 'ko');
  assert.equal(resolvePreference('en', 'ko'), 'en');
  assert.equal(resolvePreference('ko', 'en'), 'ko');
});
