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
// busy screen, a high-DPI device). Rather than dropping the user-approved
// screenshot outright, retry at progressively lower scale/quality — only if
// every attempt still comes in oversized do we give up, so the report itself
// can still submit without a doomed oversized request.
const MAX_SCREENSHOT_DATA_URL_LENGTH = 1_500_000;

// Each retry step's (scale multiplier applied to the base pixel ratio, JPEG
// quality). The first entry matches the original single-shot behavior.
const CAPTURE_QUALITY_STEPS: ReadonlyArray<{ scale: number; quality: number }> = [
  { scale: 1, quality: 0.74 },
  { scale: 0.66, quality: 0.6 },
  { scale: 0.5, quality: 0.45 },
];

async function captureWebDataUrl(ref: ViewRef, scaleMultiplier: number, quality: number): Promise<string> {
  const { default: html2canvas } = await import('html2canvas');
  const viewport = webViewportSize();
  const canvas = await html2canvas(ref.current as never, {
    backgroundColor: null,
    logging: false,
    scale: webPixelRatio() * scaleMultiplier,
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
  return canvas.toDataURL('image/jpeg', quality);
}

async function captureNativeDataUrl(ref: ViewRef, quality: number): Promise<string> {
  return captureRef(ref, {
    format: 'jpg',
    quality,
    result: 'data-uri',
  });
}

export async function captureFeedbackScreenshot(
  ref: ViewRef,
  surface: string,
): Promise<FeedbackScreenshot | null> {
  if (!ref.current) {
    return null;
  }

  let dataUrl: string | null = null;
  for (const step of CAPTURE_QUALITY_STEPS) {
    const candidate =
      Platform.OS === 'web'
        ? await captureWebDataUrl(ref, step.scale, step.quality)
        : await captureNativeDataUrl(ref, step.quality);
    if (candidate.length <= MAX_SCREENSHOT_DATA_URL_LENGTH) {
      dataUrl = candidate;
      break;
    }
  }

  if (!dataUrl) {
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
