import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';

// Placeholder Library tab — PR3 builds out the real "all kept, by collection"
// screen. For now it's a plain centered empty state so the tab is navigable.
export default function LibraryScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: palette.background, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <Text style={[styles.text, { color: palette.textSecondary }]}>Library — coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 16,
  },
});
