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
    // TALLER metrics, and a rounded, background-filled View clips its children
    // to its outline — so a pill sized tight to Roboto metrics shaves the
    // taller Samsung glyphs. Give the pill a generous floor and centre the
    // label so the text never reaches the rounded edge on any system font.
    minHeight: 42,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    // Generous lineHeight (~1.57x) so the Text's own line box contains even the
    // taller Samsung bold ink. Keep Android's default font padding (do NOT set
    // includeFontPadding:false — that tightened the box and made it clip).
    lineHeight: 22,
    fontWeight: '700',
  },
});
