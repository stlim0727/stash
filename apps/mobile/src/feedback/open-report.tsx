import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';

import { getHeroDiagnosticsSnapshot, getHeroDomDiagnostics } from '@/feedback/hero-diagnostics-session';
import { captureFeedbackScreenshot } from '@/feedback/screenshot';
import { setPendingFeedbackScreenshot, setPendingFeedbackSource, type FeedbackSourceContext } from '@/feedback/screenshot-session';

const SCREENSHOT_CAPTURE_TIMEOUT_MS = 3000;
const CaptureContext = createContext<React.RefObject<View | null>>({ current: null });

export function FeedbackCaptureProvider({ children }: { children: ReactNode }) {
  const captureRef = useRef<View>(null);
  return (
    <CaptureContext.Provider value={captureRef}>
      <View ref={captureRef} collapsable={false} style={{ flex: 1 }}>{children}</View>
    </CaptureContext.Provider>
  );
}

export function feedbackSourceFromPath(pathname: string | null): FeedbackSourceContext {
  if (!pathname || pathname === '/') {
    return { route: '/', surface: 'inbox' };
  }

  const segments = pathname
    .replace(/\/+/g, '/')
    .split('/')
    .filter(Boolean);
  let bookmarkId: string | undefined;
  if (segments[0] === 'bookmark' && segments[1]) {
    bookmarkId = segments[1];
  }
  const sanitizedSegments = segments.map((segment, index) => {
    if (index > 0 && (/^\d+$/.test(segment) || /^[0-9a-f]{8,}(-[0-9a-f]{4,}){2,}$/i.test(segment))) {
      if (!bookmarkId) {
        bookmarkId = segment;
      }
      return 'detail';
    }
    return segment.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  });
  const route = `/${sanitizedSegments.join('/')}`;
  return {
    route,
    surface: sanitizedSegments.join('_') || 'unknown',
    ...(bookmarkId ? { bookmarkId } : {}),
  };
}

type TimedResult<T> = { status: 'resolved'; value: T } | { status: 'timed_out' };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: 'resolved' as const, value })),
      new Promise<{ status: 'timed_out' }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function useOpenReport(pathname: string) {
  const router = useRouter();
  const captureRef = useContext(CaptureContext);
  const busyRef = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const openReport = async (sourceOverride?: FeedbackSourceContext) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setCapturing(true);
    let captureStartedAt: number | null = null;
    try {
      const source = sourceOverride ?? feedbackSourceFromPath(pathname);
      setPendingFeedbackSource(source);
      // Logged (not stored separately) so it rides the existing log-buffer ->
      // diagnostics.logs pipeline into the report, independent of whether the
      // screenshot capture below succeeds or times out.
      const heroSnapshot = getHeroDiagnosticsSnapshot();
      if (heroSnapshot) {
        console.info('feedback: inbox hero snapshot', JSON.stringify(heroSnapshot));
        if (Platform.OS === 'web') {
          console.info('feedback: inbox hero DOM', JSON.stringify(getHeroDomDiagnostics()));
        }
      }
      captureStartedAt = Date.now();
      console.info(
        'feedback: screenshot capture start',
        JSON.stringify({ surface: source.surface, timeoutMs: SCREENSHOT_CAPTURE_TIMEOUT_MS }),
      );
      const captureResult = await withTimeout(
        (async () => {
          // Allow the triggering sheet to unmount and its native dismissal to finish.
          await new Promise((resolve) => setTimeout(resolve, 350));
          return captureFeedbackScreenshot(captureRef, source.surface);
        })(),
        SCREENSHOT_CAPTURE_TIMEOUT_MS,
      );
      const durationMs = Date.now() - captureStartedAt;
      if (captureResult.status === 'timed_out') {
        console.warn(
          'feedback: screenshot capture timed out',
          JSON.stringify({ surface: source.surface, durationMs }),
        );
        setPendingFeedbackScreenshot(null);
      } else {
        const screenshot = captureResult.value;
        console.info(
          'feedback: screenshot capture finished',
          JSON.stringify({
            surface: source.surface,
            durationMs,
            outcome: screenshot ? 'captured' : 'empty',
            dataUrlLength: screenshot?.dataUrl.length ?? 0,
          }),
        );
        setPendingFeedbackScreenshot(screenshot);
      }
    } catch (error) {
      console.warn(
        'feedback: screenshot capture failed',
        JSON.stringify({
          durationMs: captureStartedAt === null ? null : Date.now() - captureStartedAt,
        }),
        error,
      );
      setPendingFeedbackScreenshot(null);
    } finally {
      busyRef.current = false;
      setCapturing(false);
    }
    router.push('/report');
  };

  return { openReport, capturing };
}
