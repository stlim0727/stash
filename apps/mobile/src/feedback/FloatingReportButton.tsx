import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getHeroDiagnosticsSnapshot } from '@/feedback/hero-diagnostics-session';
import { captureFeedbackScreenshot } from '@/feedback/screenshot';
import {
  setPendingFeedbackScreenshot,
  setPendingFeedbackSource,
  type FeedbackSourceContext,
} from '@/feedback/screenshot-session';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

interface FloatingReportButtonProps {
  children: React.ReactNode;
}

// 1200ms used to race out under normal conditions too — every "hero not
// visible" report on record (STASH-1X, STASH-2G, STASH-2P) came back with
// `screenshot: absent`, and each also logged heavy competing JS-thread work
// (sync full-refresh, repeated Realtime reconnects) right around the same
// moment. A tighter budget is exactly the one most likely to lose the race
// precisely when a screenshot would be most useful. The capture is opt-in and
// already shows a disabled/dimmed button while it runs, so a longer bound is
// an acceptable wait, not a silent hang.
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 3000;
const DEFAULT_BOTTOM_OFFSET = 88;
const INBOX_BOTTOM_OFFSET = 92;

export function feedbackSourceFromPath(pathname: string | null): FeedbackSourceContext {
  if (!pathname || pathname === '/') {
    return { route: '/', surface: 'inbox' };
  }

  const segments = pathname
    .replace(/\/+/g, '/')
    .split('/')
    .filter(Boolean);
  const sanitizedSegments = segments.map((segment, index) => {
    if (index > 0 && (/^\d+$/.test(segment) || /^[0-9a-f]{8,}(-[0-9a-f]{4,}){2,}$/i.test(segment))) {
      return 'detail';
    }
    return segment.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  });
  const route = `/${sanitizedSegments.join('/')}`;
  return {
    route,
    surface: sanitizedSegments.join('_') || 'unknown',
  };
}

function isInbox(pathname: string | null): boolean {
  return !pathname || pathname === '/';
}

function shouldHide(pathname: string | null): boolean {
  return pathname === '/report' || pathname === '/auth/callback';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function FloatingReportButton({ children }: FloatingReportButtonProps) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const captureRef = useRef<View>(null);
  const [capturing, setCapturing] = useState(false);
  const hidden = shouldHide(pathname);

  const openReport = async () => {
    if (capturing) {
      return;
    }
    setCapturing(true);
    try {
      const source = feedbackSourceFromPath(pathname);
      setPendingFeedbackSource(source);
      // Logged (not stored separately) so it rides the existing log-buffer ->
      // diagnostics.logs pipeline into the report, independent of whether the
      // screenshot capture below succeeds or times out.
      const heroSnapshot = getHeroDiagnosticsSnapshot();
      if (heroSnapshot) {
        console.info('feedback: inbox hero snapshot', JSON.stringify(heroSnapshot));
      }
      setPendingFeedbackScreenshot(
        await withTimeout(
          captureFeedbackScreenshot(captureRef, source.surface),
          SCREENSHOT_CAPTURE_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      console.warn('feedback screenshot capture failed', error);
      setPendingFeedbackScreenshot(null);
    } finally {
      setCapturing(false);
    }
    router.push('/report');
  };

  const buttonStyle: StyleProp<ViewStyle> = [
    styles.button,
    {
      backgroundColor: palette.accent,
      bottom: Math.max(
        insets.bottom + (isInbox(pathname) ? INBOX_BOTTOM_OFFSET : DEFAULT_BOTTOM_OFFSET),
        DEFAULT_BOTTOM_OFFSET,
      ),
      opacity: capturing ? 0.7 : 1,
    },
  ];

  return (
    <View style={styles.root}>
      <View ref={captureRef} collapsable={false} style={styles.captureSurface}>
        {children}
      </View>
      {hidden ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('settings.report.label')}
          disabled={capturing}
          onPress={() => void openReport()}
          style={({ pressed }) => [buttonStyle, pressed && styles.pressed]}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={18} color="#ffffff" />
          <Text style={styles.label}>{t('settings.report.label')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  captureSurface: {
    flex: 1,
  },
  button: {
    ...overlayLayer(50),
    position: 'absolute',
    right: 16,
    minHeight: 44,
    maxWidth: 188,
    borderRadius: 22,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
});
