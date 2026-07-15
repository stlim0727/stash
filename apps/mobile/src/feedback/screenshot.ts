import { Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import type { RefObject } from 'react';

export interface FeedbackScreenshot {
  dataUrl: string;
  mimeType: 'image/jpeg';
  capturedAt: string;
  platform: string;
  surface: string;
}

type ViewRef = RefObject<View | null>;

function webPixelRatio(): number {
  const value =
    typeof globalThis === 'object' && 'devicePixelRatio' in globalThis
      ? Number((globalThis as { devicePixelRatio?: number }).devicePixelRatio)
      : 1;
  return Number.isFinite(value) && value > 0 ? Math.min(value, 2) : 1;
}

// html2canvas defaults to rendering an element's full scrollWidth/scrollHeight,
// not just what's visible in the viewport — on a long scrollable screen (e.g.
// the Inbox with hundreds of bookmark cards) that produces a canvas many times
// taller than the screen, and the resulting base64 JPEG can be large enough
// that the feedback POST fails outright ("Failed to fetch": Sentry STASH-2G).
// Constraining the capture to the viewport keeps it bounded regardless of how
// much content the current screen happens to have scrolled to.
function webViewportSize(): { width: number; height: number } | null {
  if (typeof window !== 'object' || !window.innerWidth || !window.innerHeight) {
    return null;
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

// Belt-and-suspenders cap on the final data URL: even a viewport-bounded
// capture could still be unexpectedly large (a very tall phone viewport, a
// busy screen). Dropping an oversized screenshot rather than attempting the
// doomed request keeps the report itself from failing to submit — the text
// report and diagnostics still go through.
const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;

export async function captureFeedbackScreenshot(
  ref: ViewRef,
  surface: string,
): Promise<FeedbackScreenshot | null> {
  if (!ref.current) {
    return null;
  }

  let dataUrl: string;
  if (Platform.OS === 'web') {
    const { default: html2canvas } = await import('html2canvas');
    const viewport = webViewportSize();
    const canvas = await html2canvas(ref.current as never, {
      backgroundColor: null,
      logging: false,
      scale: webPixelRatio(),
      useCORS: true,
      ...(viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            windowWidth: viewport.width,
            windowHeight: viewport.height,
          }
        : {}),
    });
    dataUrl = canvas.toDataURL('image/jpeg', 0.74);
  } else {
    dataUrl = await captureRef(ref, {
      format: 'jpg',
      quality: 0.74,
      result: 'data-uri',
    });
  }

  if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH) {
    return null;
  }

  return {
    dataUrl,
    mimeType: 'image/jpeg',
    capturedAt: new Date().toISOString(),
    platform: Platform.OS,
    surface,
  };
}
