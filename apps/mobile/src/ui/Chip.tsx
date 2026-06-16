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
    // Android clips a rounded, background-filled View to its outline, so the
    // PILL itself shaves the chip text if it's sized tight to the label. Bold
    // text also renders a few px past its measured line box. Give the pill a
    // real floor and centre the label so there's always slack below the glyphs.
    // (This — not the ScrollView height — was the actual clip the earlier
    // passes #58/#60/#62 never reached.)
    minHeight: 36,
    paddingVertical: 7,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    // Keep Android's default font padding (do NOT set includeFontPadding:false)
    // — it reserves descender room; removing it tightened the box and clipped.
    // A generous lineHeight leaves vertical room for bold glyphs.
    lineHeight: 20,
    fontWeight: '700',
  },
});
