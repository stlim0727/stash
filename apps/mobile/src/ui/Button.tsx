import { Ionicons } from '@expo/vector-icons';
import { forwardRef, type ComponentProps, type ElementRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette } from '@/theme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const ICON_SIZE: Record<ButtonSize, number> = { sm: 15, md: 17, lg: 19 };

interface ButtonProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading icon, laid out in a row before the label. */
  icon?: ComponentProps<typeof Ionicons>['name'];
  style?: StyleProp<ViewStyle>;
}

export const Button = forwardRef<ElementRef<typeof Pressable>, ButtonProps>(function Button(
  { children, variant = 'primary', size = 'md', icon, disabled, style, ...props },
  ref,
) {
  const palette = usePalette();
  const colors = {
    primary: { backgroundColor: palette.accent, borderColor: palette.accent, color: palette.accentForeground },
    secondary: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, color: palette.accentText },
    ghost: { backgroundColor: 'transparent', borderColor: palette.border, color: palette.text },
    danger: { backgroundColor: palette.dangerSoft, borderColor: palette.dangerSoft, color: palette.danger },
  }[variant];

  const label = (
    <Text style={[styles.label, styles[`${size}Label`], { color: colors.color }]}>{children}</Text>
  );

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor, opacity: disabled ? 0.5 : pressed ? 0.82 : 1 },
        style,
      ]}
      {...props}
    >
      {icon ? (
        <View style={styles.row}>
          <Ionicons name={icon} size={ICON_SIZE[size]} color={colors.color} />
          {label}
        </View>
      ) : (
        label
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sm: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  md: {
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  lg: {
    paddingVertical: 15,
    paddingHorizontal: 22,
  },
  label: {
    fontWeight: '700',
  },
  smLabel: {
    fontSize: 13,
  },
  mdLabel: {
    fontSize: 15,
  },
  lgLabel: {
    fontSize: 16,
  },
});
