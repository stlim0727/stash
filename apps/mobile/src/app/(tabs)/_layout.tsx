import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';

// Height of the tab bar's content area (above the safe-area inset). Exported so
// each tab's scroll list and floating FAB can reserve room for the bar and not
// hide content behind it.
export const TAB_BAR_HEIGHT = 64;

export default function TabsLayout() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textSecondary,
        // Variant B — anchored rounded-top bar: seated at the bottom edge, its
        // top corners rounded and lifted off the content with a border + shadow
        // so it reads as a raised surface rather than a flat footer.
        tabBarStyle: {
          backgroundColor: palette.surfaceElevated,
          borderTopWidth: 1,
          borderTopColor: palette.border,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom + 6,
          paddingTop: 8,
          // Raise the bar above the content (elevation on Android, shadow on iOS).
          elevation: 8,
          ...Platform.select({
            ios: {
              shadowColor: '#101828',
              shadowOffset: { width: 0, height: -4 },
              shadowOpacity: 0.08,
              shadowRadius: 12,
            },
            default: {},
          }),
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.inbox'),
          tabBarIcon: ({ color, size }) => <Ionicons name="file-tray" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: t('nav.library'),
          tabBarIcon: ({ color, size }) => <Ionicons name="library" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="tags"
        options={{
          title: t('nav.tags'),
          tabBarIcon: ({ color, size }) => <Ionicons name="pricetags" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
