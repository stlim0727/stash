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
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  label: {
    fontSize: 14,
    // Bold glyphs (incl. CJK) clip at the bottom on Android unless the line box
    // is both tall enough AND free of the default font padding:
    //   - lineHeight 20 (~1.43x) leaves room for descenders above fontSize 14.
    //   - includeFontPadding:false drops Android's extra top/bottom padding,
    //     which otherwise inflates the measured line past lineHeight and slices
    //     the descenders inside the Text view itself (the bug #58/#60/#62 kept
    //     half-fixing — earlier passes set lineHeight but never this flag).
    //   - textAlignVertical:center keeps the glyph centred in that line box.
    lineHeight: 20,
    includeFontPadding: false,
    textAlignVertical: 'center',
    fontWeight: '700',
  },
});
