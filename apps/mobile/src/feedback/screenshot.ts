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

export async function captureFeedbackScreenshot(
  ref: ViewRef,
  surface: string,
): Promise<FeedbackScreenshot | null> {
  if (!ref.current) {
    return null;
  }

  let dataUrl: string;
  if (Platform.OS === 'web') {
    const html2canvasModule = await import('html2canvas');
    const html2canvas = html2canvasModule.default ?? html2canvasModule;
    const canvas = await html2canvas(ref.current as never, {
      backgroundColor: null,
      logging: false,
      scale: webPixelRatio(),
      useCORS: true,
    });
    dataUrl = canvas.toDataURL('image/jpeg', 0.74);
  } else {
    dataUrl = await captureRef(ref, {
      format: 'jpg',
      quality: 0.74,
      result: 'data-uri',
    });
  }

  return {
    dataUrl,
    mimeType: 'image/jpeg',
    capturedAt: new Date().toISOString(),
    platform: Platform.OS,
    surface,
  };
}
