import type {
  AnalyticsEvent,
  AnalyticsEventName,
  AppOpenEvent,
  ScreenViewedEvent,
} from './events.ts';
import { EVENT_CATALOG } from './events.ts';

const FORBIDDEN_SUBSTRINGS = [
  'url',
  'uri',
  'href',
  'title',
  'note',
  'text',
  'query',
  'search',
  'tag',
  'collection',
  'prompt',
  'email',
];

const FORBIDDEN_TOKENS = new Set([
  'user',
  'account',
  'bookmark',
  'attempt',
  'id',
  'uuid',
  'guid',
  'timestamp',
  'time',
]);

const SENSITIVE_PATTERNS = [
  /https?:\/\/[^\s]+/i,
  /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/.*)?$/,
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^(?:[a-z]{2,5}_[a-zA-Z0-9]+|[0-9a-fA-F]{16,})$/,
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/,
];

export function isForbiddenKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (lowerKey.includes(sub)) {
      return true;
    }
  }

  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  for (const token of tokens) {
    if (FORBIDDEN_TOKENS.has(token)) {
      return true;
    }
  }

  return false;
}

export function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  if (proto !== null && proto !== Object.prototype) {
    return false;
  }
  const ownProps = Object.getOwnPropertyNames(val);
  if (
    ownProps.includes('__proto__') ||
    ownProps.includes('constructor') ||
    ownProps.includes('prototype')
  ) {
    return false;
  }
  return true;
}

export interface SanitizationResult {
  readonly event: AnalyticsEvent | null;
  readonly reason: string | null;
}

export function sanitizeEventWithReason(input: unknown): SanitizationResult {
  if (!isPlainObject(input)) {
    return {
      event: null,
      reason: 'Event must be a plain object with no prototype pollution',
    };
  }

  const ownKeys = Object.getOwnPropertyNames(input);
  if (ownKeys.length !== 2 || !ownKeys.includes('name') || !ownKeys.includes('properties')) {
    return {
      event: null,
      reason: 'Event must contain exactly "name" and "properties" top-level keys',
    };
  }

  for (const key of ownKeys) {
    if (isForbiddenKey(key)) {
      return { event: null, reason: `Forbidden top-level key: "${key}"` };
    }
  }

  const name = input.name;
  if (typeof name !== 'string') {
    return { event: null, reason: 'Event name must be a string' };
  }

  if (!(name in EVENT_CATALOG)) {
    return { event: null, reason: `Unknown event name: "${name}"` };
  }

  const eventName = name as AnalyticsEventName;
  const catalogEntry = EVENT_CATALOG[eventName];

  const props = input.properties;
  if (!isPlainObject(props)) {
    return {
      event: null,
      reason: 'Properties must be a plain object with no prototype pollution',
    };
  }

  const propKeys = Object.getOwnPropertyNames(props);

  for (const key of propKeys) {
    if (isForbiddenKey(key)) {
      return { event: null, reason: `Forbidden property key: "${key}"` };
    }
  }

  const catalogKeys = Object.keys(catalogEntry);

  for (const key of propKeys) {
    if (!(key in catalogEntry)) {
      return {
        event: null,
        reason: `Unknown property "${key}" for event "${eventName}"`,
      };
    }
  }

  for (const key of catalogKeys) {
    if (!propKeys.includes(key)) {
      return {
        event: null,
        reason: `Missing required property "${key}" for event "${eventName}"`,
      };
    }
  }

  const sanitizedProperties: Record<string, unknown> = {};

  for (const key of catalogKeys) {
    const val = props[key];

    if (typeof val === 'number' && !Number.isFinite(val)) {
      return {
        event: null,
        reason: `Non-finite number for property "${key}"`,
      };
    }

    if (typeof val === 'object' && val !== null) {
      return {
        event: null,
        reason: `Nested object or array detected in property "${key}"`,
      };
    }

    if (typeof val === 'function' || typeof val === 'symbol') {
      return {
        event: null,
        reason: `Unsupported property value type for "${key}"`,
      };
    }

    const allowedValues = (catalogEntry as Record<string, ReadonlySet<string>>)[key];
    if (typeof val !== 'string' || !allowedValues.has(val)) {
      if (isSensitiveValue(val)) {
        return {
          event: null,
          reason: `Value for property "${key}" resembles sensitive data`,
        };
      }
      return {
        event: null,
        reason: `Invalid value "${String(val)}" for property "${key}" in event "${eventName}"`,
      };
    }

    sanitizedProperties[key] = val;
  }

  const cleanEvent: AnalyticsEvent =
    eventName === 'app_open'
      ? Object.freeze({
          name: eventName,
          properties: Object.freeze({
            platform: sanitizedProperties.platform,
            auth_state: sanitizedProperties.auth_state,
          }),
        } as AppOpenEvent)
      : Object.freeze({
          name: eventName,
          properties: Object.freeze({ screen: sanitizedProperties.screen }),
        } as ScreenViewedEvent);

  return { event: cleanEvent, reason: null };
}

export function sanitizeEvent(input: unknown): AnalyticsEvent | null {
  return sanitizeEventWithReason(input).event;
}

export function getSanitizationReason(input: unknown): string | null {
  return sanitizeEventWithReason(input).reason;
}
