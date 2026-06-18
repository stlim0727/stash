import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Animated, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';

const TOAST_VISIBLE_MS = 2200;

interface CaptureToastContextValue {
  /** Show a short, non-blocking confirmation (e.g. "Saved to Stash"). */
  show: (message: string) => void;
}

const CaptureToastContext = createContext<CaptureToastContextValue | null>(null);

/**
 * A single app-wide capture toast, rendered above the navigator so it survives
 * the screen change a capture triggers. Both fast-capture paths use it — the
 * OS share intake and the manual Add screen — so a duplicate, a save, or a
 * miss reads the same wherever it came from. Never blocks; auto-dismisses.
 */
export function CaptureToastProvider({ children }: { children: ReactNode }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: string) => setMessage(next), []);

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

  return (
    <CaptureToastContext.Provider value={{ show }}>
      {children}
      {message ? (
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
      ) : null}
    </CaptureToastContext.Provider>
  );
}

export function useCaptureToast(): CaptureToastContextValue {
  const context = useContext(CaptureToastContext);
  if (!context) {
    throw new Error('useCaptureToast must be used within a CaptureToastProvider');
  }
  return context;
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
