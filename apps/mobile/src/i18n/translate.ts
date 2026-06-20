/**
 * The translation engine: catalog lookup with English fallback, plural
 * selection, `{placeholder}` interpolation, and locale-aware number/date
 * formatting. Pure — no React, no native modules — so it runs in the Node lane.
 */
import { ko } from '@/i18n/ko';
import { en, type Message, type MessageKey } from '@/i18n/messages';
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale';

const CATALOGS = { en, ko } as const;

export type TParam = string | number;
export type TParams = Record<string, TParam>;

export type TFunction = <K extends MessageKey>(key: K, params?: TParams) => string;

/** Pick the right plural variant for the locale. Korean has no plural. */
function selectPlural(message: Message, locale: Locale, params?: TParams): string {
  if (typeof message === 'string') {
    return message;
  }
  if (locale === 'en') {
    const count = typeof params?.count === 'number' ? params.count : NaN;
    return count === 1 && message.one !== undefined ? message.one : message.other;
  }
  return message.other;
}

/** Replace `{name}` tokens with params; numbers are locale-formatted. */
function interpolate(template: string, locale: Locale, params?: TParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      return match;
    }
    return typeof value === 'number' ? formatNumber(value, locale) : value;
  });
}

/**
 * Build a translator bound to one locale. Lookups fall back to the English
 * catalog, then to the raw key (so a typo surfaces visibly rather than blank).
 */
export function createT(locale: Locale): TFunction {
  const active = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  return (key, params) => {
    const message: Message | undefined = active[key] ?? en[key];
    if (message === undefined) {
      return key;
    }
    return interpolate(selectPlural(message, locale, params), locale, params);
  };
}

export function formatNumber(value: number, locale: Locale): string {
  try {
    return value.toLocaleString(locale);
  } catch {
    return String(value);
  }
}

export function formatDate(
  value: string | number | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  try {
    return date.toLocaleString(locale, options);
  } catch {
    return date.toLocaleString();
  }
}
