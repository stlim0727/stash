import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { countUntriaged } from '@/domain/untriaged';
import { useT } from '@/i18n';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

// Height of the tab bar's content area (above the safe-area inset). Exported so
// each tab's scroll list and floating FAB can reserve room for the bar and not
// hide content behind it.
export const TAB_BAR_HEIGHT = 64;

// Net downward scroll (px) that fully slides the bar + FAB out of view. Small so
// the chrome gets out of the way after a short flick and returns just as quickly
// on scroll-up — the same diffClamp trick the Inbox header already uses, tuned
// tighter for the persistent chrome.
const CHROME_HIDE_DISTANCE = 56;

/**
 * Shared scroll signal for the tab shell. Each tab pipes its list's scroll
 * offset into `scrollY`; the tab bar and the Inbox FAB both read the derived
 * `hidden` (0 = shown → 1 = hidden) so they slide away together as you read down
 * and slide back on scroll-up. One source of truth so the header, the bar, and
 * the FAB never disagree about which way you're scrolling.
 */
type TabChrome = {
  scrollY: Animated.Value;
  hidden: Animated.AnimatedInterpolation<number>;
};
const TabChromeContext = createContext<TabChrome | null>(null);

export function useTabChrome(): TabChrome {
  const ctx = useContext(TabChromeContext);
  // A screen rendered outside the tab shell (e.g. a component test mounting it
  // in isolation) still needs a working signal to write to — hand it a private
  // no-op one rather than throwing. The provider's value wins whenever present.
  const fallbackScrollY = useRef(new Animated.Value(0)).current;
  const fallback = useMemo<TabChrome>(
    () => ({
      scrollY: fallbackScrollY,
      hidden: Animated.diffClamp(fallbackScrollY, 0, CHROME_HIDE_DISTANCE).interpolate({
        inputRange: [0, CHROME_HIDE_DISTANCE],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    }),
    [fallbackScrollY],
  );
  return ctx ?? fallback;
}

// Structural view of the bottom-tab render-prop args — just the fields the
// custom bar reads, so we don't depend on expo-router's vendored navigation
// types (BottomTabBar itself isn't a stable import from expo-router).
type TabBarProps = {
  state: { index: number; routes: Array<{ key: string; name: string }> };
  descriptors: Record<
    string,
    {
      options: {
        title?: string;
        tabBarIcon?: (props: { focused: boolean; color: string; size: number }) => ReactNode;
        tabBarBadge?: number | string;
        tabBarBadgeStyle?: { backgroundColor?: string; color?: string };
      };
    }
  >;
  navigation: {
    emit: (event: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
};

/**
 * The anchored rounded-top bottom bar (Variant B), rendered by hand so it can
 * ride a scroll-driven `translateY`: it slides down out of view as the list
 * scrolls down and slides back on scroll-up, reclaiming vertical space while
 * reading. RN's default bar can't animate, hence the custom render — it reads
 * the same per-screen options (icon, title, the neutral un-triaged badge) the
 * navigator config still supplies, so behavior is unchanged, only motion added.
 */
function HidingTabBar({ state, descriptors, navigation, hidden }: TabBarProps & { hidden: Animated.AnimatedInterpolation<number> }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const fullHeight = TAB_BAR_HEIGHT + insets.bottom;
  return (
    <Animated.View
      style={[
        styles.bar,
        {
          backgroundColor: palette.surfaceElevated,
          borderTopColor: palette.border,
          height: fullHeight,
          paddingBottom: insets.bottom + 6,
          transform: [{ translateY: Animated.multiply(hidden, fullHeight) }],
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const focused = state.index === index;
        const color = focused ? palette.accent : palette.textSecondary;
        const label = options.title ?? route.name;
        const badge = options.tabBarBadge;
        const badgeStyle = options.tabBarBadgeStyle ?? {};
        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            onPress={onPress}
            style={styles.tabItem}
          >
            <View style={styles.tabIcon}>
              {options.tabBarIcon?.({ focused, color, size: 24 })}
              {typeof badge === 'number' && badge > 0 ? (
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: badgeStyle.backgroundColor ?? palette.border },
                  ]}
                >
                  <Text
                    style={[styles.badgeText, { color: badgeStyle.color ?? palette.text }]}
                    numberOfLines={1}
                  >
                    {badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.tabLabel, { color }]} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

export default function TabsLayout() {
  const palette = usePalette();
  const t = useT();
  // Un-triaged count for the Inbox badge — the same "active bookmarks with no
  // collection" rule the Inbox's "No collection" browse facet counts with
  // (`countUntriaged`). This is deliberately NEUTRAL, not a red-alert badge, and
  // is hidden entirely at zero: a queue that can reach empty, per the "no debt
  // number" design bet.
  const { inbox } = useBookmarks();
  const untriaged = countUntriaged(inbox);

  // Shared scroll signal: tabs feed `scrollY`, the bar + FAB read `hidden`.
  const scrollY = useRef(new Animated.Value(0)).current;
  const hidden = useMemo(
    () =>
      Animated.diffClamp(scrollY, 0, CHROME_HIDE_DISTANCE).interpolate({
        inputRange: [0, CHROME_HIDE_DISTANCE],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [scrollY],
  );
  const chrome = useMemo(() => ({ scrollY, hidden }), [scrollY, hidden]);

  return (
    <TabChromeContext.Provider value={chrome}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: palette.accent,
          tabBarInactiveTintColor: palette.textSecondary,
        }}
        tabBar={(props) => <HidingTabBar {...(props as unknown as TabBarProps)} hidden={hidden} />}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('nav.inbox'),
            tabBarIcon: ({ color, size }) => <Ionicons name="file-tray" size={size} color={color} />,
            // Neutral un-triaged count — hidden at zero (`undefined`), and styled
            // with the muted border/text palette so it reads as a calm tally, never
            // a red danger alert.
            tabBarBadge: untriaged > 0 ? untriaged : undefined,
            tabBarBadgeStyle: {
              backgroundColor: palette.border,
              color: palette.text,
              fontSize: 11,
              fontWeight: '600',
            },
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
    </TabChromeContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Variant B — anchored rounded-top bar: seated at the bottom edge, top corners
  // rounded and lifted off the content with a border + shadow so it reads as a
  // raised surface. Rendered as a normal-flow element so the navigator still
  // reserves its height (no content jump); the translateY only slides it visually.
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
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
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabIcon: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
