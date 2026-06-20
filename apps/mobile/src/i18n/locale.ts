/**
 * Locale identity + the user's language preference.
 *
 * Pure and platform-free (no React, no native modules) so it runs in the Node
 * test lane. Device-locale *detection* (which needs `expo-localization`) lives
 * in `index.tsx`; this file only knows how to turn raw locale tags and a stored
 * preference string into one of our supported locales.
 */

/** Locales Stash ships message catalogs for. English is the source of truth. */
export const SUPPORTED_LOCALES = ['en', 'ko'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Fallback when the device language isn't one we translate. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * What the user picked in Settings. `'system'` follows the device language;
 * a concrete locale overrides it. Stored verbatim in the meta store.
 */
export type LocalePreference = 'system' | Locale;

export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = 'system';

/** Persistence key for the language override (durable repository meta store). */
export const LOCALE_PREF_KEY = 'pref.locale';

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function parseLocalePreference(raw: string | null | undefined): LocalePreference {
  return raw === 'system' || isSupportedLocale(raw) ? raw : DEFAULT_LOCALE_PREFERENCE;
}

export function serializeLocalePreference(preference: LocalePreference): string {
  return preference;
}

/**
 * Pick the best supported locale from a list of BCP-47 tags (most-preferred
 * first), matching on the primary language subtag so `ko-KR` maps to `ko`.
 * Falls back to English when nothing matches.
 */
export function resolveLocaleFromTags(
  tags: ReadonlyArray<string | null | undefined>,
): Locale {
  for (const tag of tags) {
    const language = tag?.toLowerCase().split('-')[0];
    if (isSupportedLocale(language)) {
      return language;
    }
  }
  return DEFAULT_LOCALE;
}

/** Resolve the preference against the detected device locale into one locale. */
export function resolvePreference(
  preference: LocalePreference,
  deviceLocale: Locale,
): Locale {
  return preference === 'system' ? deviceLocale : preference;
}
