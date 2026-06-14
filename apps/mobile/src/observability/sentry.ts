/**
 * Thin React Native shell over the Sentry SDK — the one place that touches
 * `@sentry/react-native`. All decision logic lives in the pure, unit-tested
 * `sentry-config.ts`; this module just calls `Sentry.init` with what that
 * produces and exposes `wrapWithSentry` for the root component.
 *
 * When no DSN is configured, `initSentry` is a no-op and `wrapWithSentry` is the
 * identity wrapper, so the app runs unchanged in local/preview environments.
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import type { ComponentType } from 'react';

import { buildSentryInitOptions, getSentryConfigState } from './sentry-config';

let started = false;

/** Initialize crash & error monitoring. Safe to call more than once; only the
 *  first call with a configured DSN takes effect. Returns whether monitoring
 *  is active. */
export function initSentry(): boolean {
  if (started) {
    return true;
  }
  const options = buildSentryInitOptions(getSentryConfigState(), {
    release: Constants.expoConfig?.version ?? null,
  });
  if (!options) {
    return false;
  }
  Sentry.init(options);
  started = true;
  return true;
}

/** Wrap the root component so unhandled render/runtime errors are captured.
 *  Harmless when monitoring is disabled. */
export function wrapWithSentry<P extends Record<string, unknown>>(
  component: ComponentType<P>,
): ComponentType<P> {
  return Sentry.wrap(component);
}

/** Associate the current (anonymous) Supabase user id with future events.
 *  Only the opaque id is sent — never email or content. Pass null to clear. */
export function setSentryUser(userId: string | null): void {
  Sentry.setUser(userId ? { id: userId } : null);
}
