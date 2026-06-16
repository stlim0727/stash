import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initSentry, wrapWithSentry } from '@/observability/sentry';
import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';

// Start crash & error monitoring as early as possible — a no-op until a DSN is
// configured (see observability/sentry-config).
initSentry();

function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <SupabaseAuthProvider>
            <BookmarksProvider>
              <ShareIntentHandler />
              <Stack>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen
                  name="add"
                  options={{ title: 'Add Bookmark', presentation: 'modal' }}
                />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen
                  name="account"
                  options={{ title: 'Account', presentation: 'modal' }}
                />
                <Stack.Screen name="review" options={{ title: 'Review AI suggestions' }} />
                <Stack.Screen name="report" options={{ title: 'Report a problem' }} />
                <Stack.Screen name="archived" options={{ title: 'Archived' }} />
                <Stack.Screen name="bookmark/[id]" options={{ title: 'Bookmark' }} />
              </Stack>
              <StatusBar style="auto" />
            </BookmarksProvider>
          </SupabaseAuthProvider>
        </ThemeProvider>
      </ShareIntentProvider>
    </SafeAreaProvider>
  );
}

// Wrap the root so unhandled errors anywhere in the tree are captured.
export default wrapWithSentry(RootLayout);
