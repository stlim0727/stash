// Ambient placeholder for in-flight AI suggestions. A row of softly pulsing
// ghost pills that reads as "suggestions are filling in here" rather than a
// centered spinner with a "working…" label, which feels like a blocking,
// modal wait. Used while an enrichment request is in flight (auto or manual);
// see apps/mobile/src/app/bookmark/[id].tsx.

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '@/i18n';
import { usePalette } from '@/theme';

// Varied widths so the ghosts read as "incoming tag chips", not a progress bar.
const PILL_WIDTHS = [64, 88, 72];

export function SuggestionSkeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  const { t } = useI18n();
  // Drive opacity only (useNativeDriver) so the pulse stays cheap and never
  // blocks the JS thread while the user keeps interacting with the screen.
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={t('detail.aiWorking')}
      style={[styles.row, style]}
    >
      {PILL_WIDTHS.map((width, index) => (
        <Animated.View
          key={index}
          style={[styles.pill, { width, backgroundColor: palette.mutedSurface, opacity: pulse }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pill: {
    height: 24,
    borderRadius: 12,
  },
});
