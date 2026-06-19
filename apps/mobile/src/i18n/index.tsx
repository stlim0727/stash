/**
 * The i18n React layer: detects the device locale, loads the user's stored
 * language override, and exposes a `t()` translator plus locale-aware
 * formatters through context. The only i18n file that imports a native module
 * (`expo-localization`), mirroring how `run-oauth.ts` isolates native imports.
 *
 * Locale resolution never blocks capture: the device locale is read
 * synchronously at first render and the stored override loads in the
 * background, so the UI is usable immediately (system-language users see no
 * flash at all).
 */
import * as Localization from 'expo-localization';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { getPreference, setPreference } from '@/storage/preferences';

import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  LOCALE_PREF_KEY,
  parseLocalePreference,
  resolveLocaleFromTags,
  resolvePreference,
  serializeLocalePreference,
  type Locale,
  type LocalePreference,
} from '@/i18n/locale';
import { createT, formatDate, formatNumber, type TFunction } from '@/i18n/translate';

export interface I18nValue {
  /** The resolved active locale (preference applied over the device default). */
  locale: Locale;
  /** What the user picked: `'system'` or a concrete locale. */
  preference: LocalePreference;
  /** Translate a message key, with optional interpolation params. */
  t: TFunction;
  /** Persist + apply a new language preference. */
  setLocalePreference: (preference: LocalePreference) => void;
  /** Locale-aware date/time formatting. */
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  /** Locale-aware number formatting. */
  formatNumber: (value: number) => string;
}

/** The best supported locale for the device, read synchronously. */
function detectDeviceLocale(): Locale {
  try {
    const tags = Localization.getLocales().map((entry) => entry.languageTag ?? entry.languageCode);
    return resolveLocaleFromTags(tags);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** A context default usable without a provider (keeps unit tests simple). */
function makeValue(locale: Locale, preference: LocalePreference, setPref: (p: LocalePreference) => void): I18nValue {
  return {
    locale,
    preference,
    t: createT(locale),
    setLocalePreference: setPref,
    formatDate: (value, options) => formatDate(value, locale, options),
    formatNumber: (value) => formatNumber(value, locale),
  };
}

const noop = () => {};
const I18nContext = createContext<I18nValue>(
  makeValue(DEFAULT_LOCALE, DEFAULT_LOCALE_PREFERENCE, noop),
);

export function I18nProvider({ children }: { children: ReactNode }) {
  const deviceLocale = useMemo(detectDeviceLocale, []);
  const [preference, setPreferenceState] = useState<LocalePreference>(DEFAULT_LOCALE_PREFERENCE);
  const loaded = useRef(false);

  useEffect(() => {
    let active = true;
    getPreference(LOCALE_PREF_KEY)
      .then((raw) => {
        if (active) {
          setPreferenceState(parseLocalePreference(raw));
        }
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      active = false;
    };
  }, []);

  const setLocalePreference = useCallback((next: LocalePreference) => {
    setPreferenceState(next);
    void setPreference(LOCALE_PREF_KEY, serializeLocalePreference(next)).catch(() => {});
  }, []);

  const locale = resolvePreference(preference, deviceLocale);
  const value = useMemo<I18nValue>(
    () => makeValue(locale, preference, setLocalePreference),
    [locale, preference, setLocalePreference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** Shorthand for components that only need the translator. */
export function useT(): TFunction {
  return useContext(I18nContext).t;
}

export type { Locale, LocalePreference } from '@/i18n/locale';
export { SUPPORTED_LOCALES } from '@/i18n/locale';
