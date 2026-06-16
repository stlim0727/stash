import type { ReactNode } from 'react';
import { PixelRatio, Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette } from '@/theme';

type ChipVariant = 'default' | 'selected' | 'accent' | 'danger';

interface ChipProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  variant?: ChipVariant;
  style?: StyleProp<ViewStyle>;
}

const LABEL_FONT_SIZE = 14;
// Line box as a ratio of the font size. 1.4 leaves comfortable room for bold
// glyph descenders, which Android otherwise clips when the line box hugs the
// text too tightly.
const LABEL_LINE_RATIO = 1.4;

export function Chip({ children, variant = 'default', disabled, style, ...props }: ChipProps) {
  const palette = usePalette();
  const colors = {
    default: { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text },
    selected: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    accent: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    danger: { backgroundColor: palette.dangerSoft, borderColor: palette.dangerSoft, color: palette.danger },
  }[variant];

  // Scale the line height with the OS font setting. A fixed lineHeight does NOT
  // grow when the user enlarges their system font, but the font size does — so
  // at larger font settings the text outgrows a fixed line box and the
  // descenders clip again. Deriving it from getFontScale() keeps the line box
  // proportional to the actual rendered text at every font/display size.
  const lineHeight = Math.round(LABEL_FONT_SIZE * LABEL_LINE_RATIO * PixelRatio.getFontScale());

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
      <Text style={[styles.label, { color: colors.color, lineHeight }]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  label: {
    fontSize: LABEL_FONT_SIZE,
    fontWeight: '700',
  },
});
