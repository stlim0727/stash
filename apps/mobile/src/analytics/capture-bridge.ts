import type { AnalyticsEvent } from './events.ts';

type Capture = (event: AnalyticsEvent) => void;

let activeCapture: Capture | null = null;

/**
 * Lets infrastructure above the AnalyticsProvider emit allowlisted events
 * without importing React context. The provider owns the registration and
 * clears only its own callback on unmount.
 */
export function registerAnalyticsCapture(capture: Capture): () => void {
  activeCapture = capture;
  return () => {
    if (activeCapture === capture) activeCapture = null;
  };
}

export function captureAnalytics(event: AnalyticsEvent): void {
  activeCapture?.(event);
}
