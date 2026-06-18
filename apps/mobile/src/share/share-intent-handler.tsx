import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { extractFirstUrl } from '@/domain/urls';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

const TOAST_VISIBLE_MS = 2200;

/**
 * Bridges the OS share sheet to local-first capture. When the app is opened
 * with a shared URL we persist it immediately through the existing store
 * (which queues it for sync) and confirm with a short, non-blocking toast —
 * never opening the full editor and never waiting on the network.
 *
 * Renders nothing but the toast; the native share module is a no-op on web.
 */
export function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { addBookmark, isLoading } = useBookmarks();
  const router = useRouter();
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  const [message, setMessage] = useState<string | null>(null);
  // A share copied out of expo-share-intent, held until the store has loaded.
  // We capture it immediately (and release the OS intent) so a
  // resetOnBackground — or the user backing out during a slow SQLite load —
  // can never drop a capture; the save itself waits for the store so dedupe
  // sees the bookmarks already on the device. Capture is sacred.
  const [pendingShare, setPendingShare] = useState<{ url: string | null; title?: string } | null>(
    null,
  );
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against re-copying the same intent across renders before the reset
  // propagates; cleared once the intent goes away so a later share is captured.
  const capturedRef = useRef(false);

  // Copy the incoming share into local state right away, then release the OS
  // intent so nothing else can clear it while we wait for the store to load.
  useEffect(() => {
    if (!hasShareIntent) {
      capturedRef.current = false;
      return;
    }
    if (capturedRef.current) {
      return;
    }
    capturedRef.current = true;
    setPendingShare({
      url: shareIntent.webUrl ?? extractFirstUrl(shareIntent.text),
      title: shareIntent.meta?.title ?? undefined,
    });
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  // Save once the store has loaded, so the in-memory dedupe sees existing
  // bookmarks instead of running against an empty set during the cold start.
  useEffect(() => {
    if (!pendingShare || isLoading) {
      return;
    }
    if (pendingShare.url) {
      const result = addBookmark({ url: pendingShare.url, title: pendingShare.title });
      setMessage(result.status === 'duplicate' ? 'Already in Stash' : 'Saved to Stash');
      // Land on Inbox so the freshly stashed item is visible; this is not a
      // full editor, matching the fast-capture requirement.
      router.replace('/');
    } else {
      setMessage('No link found to stash');
    }
    setPendingShare(null);
  }, [pendingShare, isLoading, addBookmark, router]);

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
