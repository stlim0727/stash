import type { ReactNode } from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PostHogMaskView } from 'posthog-react-native';

import { usePalette } from '@/theme';

type ChipVariant = 'default' | 'selected' | 'accent' | 'danger' | 'highlight';

interface ChipProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  variant?: ChipVariant;
  quiet?: boolean;
  // Optional leading glyph. Used by the Inbox browse shelf to mark what KIND of
  // facet a chip is — a folder for collections (and a tray for the "no
  // collection" set) — so they read as collection filters rather than being
  // confused with the bare "#tag" chips beside them.
  icon?: keyof typeof Ionicons.glyphMap;
  // Optional trailing count (e.g. how many bookmarks a folder chip holds). Kept
  // as a separate muted token rather than baked into `children`, so the label
  // stays clean for the search placeholder and screen readers.
  count?: number;
  style?: StyleProp<ViewStyle>;
  // Set true when `children` is bookmark-derived content (a tag or collection
  // name) rather than a fixed UI label — hides the label from PostHog session
  // replay recordings. Chip is reused for both, so this must be opted into at
  // each content call site rather than defaulted on.
  mask?: boolean;
}

const LABEL_FONT_SIZE = 14;
const LABEL_WEIGHT = Platform.select({ web: '600', default: '700' }) as '600' | '700';
const COUNT_WEIGHT = Platform.select({ web: '500', default: '600' }) as '500' | '600';
// Line box as a ratio of the font size. ~1.57 makes the default-scale line box
// 22px — the value verified on-device to clear the taller Samsung One UI bold
// metrics (1.4 ≈ 20px still marginally clipped the glyphs). Deriving lineHeight
// from this ratio keeps the box proportional to the rendered text at every OS
// font/display size.
const LABEL_LINE_RATIO = 1.57;

export function Chip({
  children,
  variant = 'default',
  quiet,
  icon,
  count,
  disabled,
  style,
  mask,
  ...props
}: ChipProps) {
  const palette = usePalette();
  const quietDefault = quiet && variant === 'default';
  const colors = {
    default: {
      backgroundColor: quietDefault ? 'transparent' : palette.surface,
      borderColor: palette.border,
      color: quietDefault ? palette.textSecondary : palette.text,
    },
    selected: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    accent: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    danger: { backgroundColor: palette.dangerSoft, borderColor: palette.dangerSoft, color: palette.danger },
    // A blocked/actionable status (e.g. Settings' AI-quota-reached chip) —
    // the same soft-gold token Folder View's collection tiles use
    // (`@/domain/collection-color`), reserved for this "you're waiting on a
    // timer" register rather than the neutral default pill.
    highlight: { backgroundColor: palette.highlightSoft, borderColor: palette.highlight, color: palette.text },
  }[variant];

  // Scale the line height with the OS font setting. A fixed lineHeight does NOT
  // grow when the user enlarges their system font, but the font size does — so
  // at larger font settings the text outgrows a fixed line box and the
  // descenders clip again. Deriving it from getFontScale() keeps the line box
  // proportional to the actual rendered text at every font/display size.
  const lineHeight = Math.round(LABEL_FONT_SIZE * LABEL_LINE_RATIO * PixelRatio.getFontScale());

  // PostHogMaskView forces its own `accessibilityLabel="ph-no-capture"` on
  // the wrapper around the label Text (see below), which would otherwise
  // replace this Pressable's automatic content-derived accessible name with
  // that literal string for screen readers. When masking and the caller
  // hasn't already supplied an explicit label, reconstruct the same name RN
  // would have derived from the (now-masked) label + count text, so masking
  // a chip from session replay never also makes it unnamed/mislabeled for
  // assistive tech.
  const fallbackAccessibilityLabel =
    mask && props.accessibilityLabel === undefined && typeof children === 'string'
      ? typeof count === 'number'
        ? `${children} · ${count}`
        : children
      : undefined;

  return (
    <Pressable
      disabled={disabled}
      accessibilityLabel={fallbackAccessibilityLabel}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor, opacity: disabled ? 0.5 : pressed ? 0.78 : 1 },
        style,
      ]}
      {...props}
    >
      {icon ? (
        <Ionicons name={icon} size={13} color={colors.color} style={styles.icon} testID={`chip-icon-${icon}`} />
      ) : null}
      {mask ? (
        <PostHogMaskView>
          <Text style={[styles.label, quietDefault ? styles.labelQuiet : null, { color: colors.color, lineHeight }]}>
            {children}
          </Text>
        </PostHogMaskView>
      ) : (
        <Text style={[styles.label, quietDefault ? styles.labelQuiet : null, { color: colors.color, lineHeight }]}>
          {children}
        </Text>
      )}
      {typeof count === 'number' ? (
        <Text style={[styles.count, quietDefault ? styles.countQuiet : null, { color: colors.color, lineHeight }]}>
          {`· ${count}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    // The clip only reproduces on real Samsung One UI devices, never on the
    // emulator's Roboto: Samsung's default system font renders bold text with
    // TALLER metrics. The fix that actually clears it is the label's roomy
    // lineHeight (below) — it gives that taller ink space inside the text box.
    // The pill itself only needs to be a touch taller than that line box, so
    // keep it compact: padding 6 + lineHeight 22 = 34.
    minHeight: 34,
    paddingVertical: 6,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    marginRight: 5,
  },
  label: {
    fontSize: LABEL_FONT_SIZE,
    // lineHeight is applied inline (scaled by getFontScale) — see the component.
    // Keep Android's default font padding (do NOT set includeFontPadding:false,
    // which tightened the box and made it clip).
    fontWeight: LABEL_WEIGHT,
  },
  labelQuiet: {
    fontWeight: Platform.select({ web: '500', default: LABEL_WEIGHT }) as '500' | '700',
  },
  // Trailing count: same color as the label but dimmed and lighter, so it reads
  // as secondary metadata (the folder's weight) without competing with the name.
  count: {
    fontSize: LABEL_FONT_SIZE,
    fontWeight: COUNT_WEIGHT,
    opacity: 0.55,
    marginLeft: 5,
  },
  countQuiet: {
    fontWeight: Platform.select({ web: '400', default: COUNT_WEIGHT }) as '400' | '600',
    opacity: 0.42,
  },
});
