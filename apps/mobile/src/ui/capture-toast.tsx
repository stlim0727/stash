import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

// A plain confirmation auto-dismisses quickly; one carrying a tap target stays
// up longer so there's actually time to reach for it before it slides away.
const TOAST_VISIBLE_MS = 2200;
const TOAST_WITH_ACTION_VISIBLE_MS = 5000;

/** An optional inline tap target (e.g. "View" → jump to the Inbox). */
export interface CaptureToastAction {
  label: string;
  onPress: () => void;
}

interface CaptureToastContextValue {
  /**
   * Show a short, non-blocking confirmation (e.g. "Saved to Stash"). Pass an
   * `action` to add an inline button — used by the share flow's "View" shortcut.
   */
  show: (message: string, action?: CaptureToastAction) => void;
  /**
   * Whether a toast is currently up. The toast itself stays pass-through
   * (`pointerEvents: 'none'`/`'box-none'`) so it never blocks the screen
   * underneath — but that means anything absolutely positioned in its footprint
   * still receives touches straight through it. Consumers whose own floating
   * controls overlap the toast's resting corner (the report button) use this to
   * go inert for the moment, instead of relying on the toast to intercept taps.
   */
  isVisible: boolean;
}

const CaptureToastContext = createContext<CaptureToastContextValue | null>(null);

interface ToastState {
  message: string;
  action?: CaptureToastAction;
}

/**
 * A single app-wide capture toast, rendered above the navigator so it survives
 * the screen change a capture triggers. Both fast-capture paths use it — the
 * OS share intake and the manual Add screen — so a duplicate, a save, or a
 * miss reads the same wherever it came from. Never blocks; auto-dismisses.
 *
 * It can also carry a single inline action (the share flow's "View" shortcut),
 * letting a curious user jump to the Inbox to confirm a capture without the
 * toast ever stealing focus or hijacking navigation on its own.
 */
export function CaptureToastProvider({ children }: { children: ReactNode }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  const [toast, setToast] = useState<ToastState | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, action?: CaptureToastAction) => setToast({ message, action }),
    [],
  );

  const dismiss = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) {
          setToast(null);
        }
      },
    );
  }, [opacity]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const visibleFor = toast.action ? TOAST_WITH_ACTION_VISIBLE_MS : TOAST_VISIBLE_MS;
    hideTimer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) {
            setToast(null);
          }
        },
      );
    }, visibleFor);

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
    };
  }, [toast, opacity]);

  const action = toast?.action;
  const handleActionPress = useCallback(() => {
    // Run first, then tear the toast down, so the tap always lands even if the
    // navigation it triggers unmounts us.
    action?.onPress();
    dismiss();
  }, [action, dismiss]);

  return (
    <CaptureToastContext.Provider value={{ show, isVisible: toast !== null }}>
      {children}
      {toast ? (
        <Animated.View
          // Only an actionable toast needs to catch touches; a plain one stays
          // fully pass-through so it can never block the screen underneath.
          pointerEvents={toast.action ? 'box-none' : 'none'}
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
          <Text style={[styles.toastText, { color: palette.text }]}>{toast.message}</Text>
          {toast.action ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.action.label}
              onPress={handleActionPress}
              hitSlop={8}
              style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.actionText, { color: palette.accent }]}>{toast.action.label}</Text>
            </Pressable>
          ) : null}
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
    // Above the floating report button/nub: that button sits bottom-left at
    // the same row as the "+" FAB, so its corner can fall under this toast's
    // resting position — the ephemeral confirmation must win over the
    // persistent button.
    ...overlayLayer(60),
    position: 'absolute',
    left: 24,
    right: 24,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      },
      // No Android elevation here: overlayLayer(60) above already sets it for
      // stacking (paint AND touch dispatch — see ui/layering.ts). Re-setting a
      // lower value here after that spread would silently claw it back down
      // and hand touch priority to anything with a higher elevation
      // underneath, e.g. the report button/nub's overlayLayer(50).
      default: {},
    }),
  },
  toastText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  action: {
    marginLeft: 'auto',
    paddingLeft: 16,
  },
  actionText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
