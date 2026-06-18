import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from '@/domain/share-behavior';
import { extractFirstUrl } from '@/domain/urls';
import { getPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

const TOAST_VISIBLE_MS = 2200;

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it immediately through the existing store
 * (which queues it for sync) and confirm with a short, non-blocking toast —
 * never opening the full editor and never waiting on the network.
 *
 * By default we don't navigate after a share: the toast is the whole
 * interaction, so a share doesn't yank you into the Inbox. Users who prefer to
 * land on the Inbox can opt in via Settings (see `share-behavior`).
 *
 * Renders nothing but the toast; the native share module is a no-op on web.
 */
export function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { addBookmark } = useBookmarks();
  const router = useRouter();
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cached so the share handler never blocks on storage; refreshed whenever a
  // share arrives so a Settings change takes effect on the next share.
  const behavior = useRef<ShareBehavior>(DEFAULT_SHARE_BEHAVIOR);

  useEffect(() => {
    if (!hasShareIntent) {
      return;
    }

    const url = shareIntent.webUrl ?? extractFirstUrl(shareIntent.text);
    if (url) {
      const result = addBookmark({ url, title: shareIntent.meta?.title ?? undefined });
      setMessage(result.status === 'duplicate' ? 'Already in Stash' : 'Saved to Stash');
      // Only jump to the Inbox when the user has opted in; otherwise the toast
      // is the entire interaction and we leave the current screen untouched.
      getPreference(SHARE_BEHAVIOR_PREF_KEY)
        .then((raw) => {
          behavior.current = parseShareBehavior(raw);
          if (behavior.current === 'inbox') {
            router.replace('/');
          }
        })
        .catch(() => {});
    } else {
      setMessage('No link found to stash');
    }

    resetShareIntent();
    // shareIntent is reset right after handling, so keying on hasShareIntent
    // is enough to fire exactly once per share.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent]);

  useEffect(() => {
    if (!message) {
      return;
    }
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    hideTimer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) {
            setMessage(null);
          }
        },
      );
    }, TOAST_VISIBLE_MS);

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
    };
  }, [message, opacity]);

  if (!message) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toast,
        {
          opacity,
          bottom: insets.bottom + 24,
          backgroundColor: palette.card,
          borderColor: palette.border,
        },
      ]}
    >
      <Text style={[styles.toastText, { color: palette.text }]}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 6 },
      default: {},
    }),
  },
  toastText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
