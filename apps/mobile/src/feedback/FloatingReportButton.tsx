import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getHeroDiagnosticsSnapshot } from '@/feedback/hero-diagnostics-session';
import { captureFeedbackScreenshot } from '@/feedback/screenshot';
import {
  setPendingFeedbackScreenshot,
  setPendingFeedbackSource,
  type FeedbackSourceContext,
} from '@/feedback/screenshot-session';
import { useT } from '@/i18n';
import { getPreference, setPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
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
// Same row as the inbox "+" FAB (bottom-right, `insets.bottom + 20`) — this
// button now sits bottom-left at the same offset instead of stacked above it.
const BOTTOM_OFFSET = 20;
// Persisted (repository meta store) so a user who long-presses this into its
// minimized nub doesn't have to redo that every app launch.
const MINIMIZED_PREF_KEY = 'pref.feedback.reportButtonMinimized';

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
  const [minimized, setMinimized] = useState(false);
  const hidden = shouldHide(pathname);
  // On web the repository's meta store is only populated once BookmarksProvider's
  // startup load resolves (`repository.init()`) — reading the preference before
  // that finishes always sees an empty store, since a fresh mount's own effect
  // runs before that ancestor's. Gate on `isLoading` so this reads only once the
  // real persisted value is available.
  const { isLoading } = useBookmarks();

  useEffect(() => {
    if (isLoading) {
      return;
    }
    let active = true;
    getPreference(MINIMIZED_PREF_KEY)
      .then((raw) => {
        if (active && raw === 'true') {
          setMinimized(true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isLoading]);

  const setMinimizedPersisted = (value: boolean) => {
    setMinimized(value);
    void setPreference(MINIMIZED_PREF_KEY, value ? 'true' : 'false').catch(() => {});
  };

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

  const bottom = insets.bottom + BOTTOM_OFFSET;

  const buttonStyle: StyleProp<ViewStyle> = [
    styles.button,
    { backgroundColor: palette.accent, bottom, opacity: capturing ? 0.7 : 1 },
  ];
  const nubStyle: StyleProp<ViewStyle> = [styles.nub, { backgroundColor: palette.accent, bottom }];

  return (
    <View style={styles.root}>
      <View ref={captureRef} collapsable={false} style={styles.captureSurface}>
        {children}
      </View>
      {hidden ? null : minimized ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.expandA11y')}
          onPress={() => setMinimizedPersisted(false)}
          style={({ pressed }) => [nubStyle, pressed && styles.pressed]}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={14} color="#ffffff" />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('settings.report.label')}
          accessibilityHint={t('report.minimizeA11yHint')}
          disabled={capturing}
          onPress={() => void openReport()}
          onLongPress={() => setMinimizedPersisted(true)}
          style={({ pressed }) => [buttonStyle, pressed && styles.pressed]}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={20} color="#ffffff" />
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
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
  },
  // Long-pressing the full button collapses it to this small, semi-transparent
  // nub so it stops competing with the rest of the UI; tapping the nub only
  // restores the full button (it never opens the report screen directly).
  nub: {
    ...overlayLayer(50),
    position: 'absolute',
    left: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.55,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
});
