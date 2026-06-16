import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette } from '@/theme';

type ChipVariant = 'default' | 'selected' | 'accent' | 'danger';

interface ChipProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  variant?: ChipVariant;
  style?: StyleProp<ViewStyle>;
}

export function Chip({ children, variant = 'default', disabled, style, ...props }: ChipProps) {
  const palette = usePalette();
  const colors = {
    default: { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text },
    selected: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    accent: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    danger: { backgroundColor: palette.dangerSoft, borderColor: palette.dangerSoft, color: palette.danger },
  }[variant];

  return (
    <Pressable
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor, opacity: disabled ? 0.5 : pressed ? 0.78 : 1 },
        style,
      ]}
      {...props}
    >
      <Text style={[styles.label, { color: colors.color }]}>{children}</Text>
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    // Roomy lineHeight (~1.57x) so the Text's own line box contains even the
    // taller Samsung bold ink. THIS is what stops the clip — not the pill size.
    // Keep Android's default font padding (do NOT set includeFontPadding:false,
    // which tightened the box and made it clip).
    lineHeight: 22,
    fontWeight: '700',
  },
});
