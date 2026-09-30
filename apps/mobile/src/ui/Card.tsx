import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette, uiMetrics } from '@/theme';

interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
  testID?: string;
}

export function Card({ children, style, elevated = false, testID }: CardProps) {
  const palette = usePalette();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: palette.surfaceElevated, borderColor: palette.border },
        elevated && palette.shadow.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: uiMetrics.radius,
  },
});
