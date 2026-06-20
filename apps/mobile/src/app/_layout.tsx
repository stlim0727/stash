import { GothicA1_700Bold, GothicA1_800ExtraBold } from '@expo-google-fonts/gothic-a1';
import { GowunDodum_400Regular } from '@expo-google-fonts/gowun-dodum';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { I18nProvider, useT } from '@/i18n';
import { initSentry, wrapWithSentry } from '@/observability/sentry';
import { installConsoleCapture } from '@/observability/log-buffer';
import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';
import { CaptureToastProvider } from '@/ui/capture-toast';

// Capture console output into an in-memory buffer so the "Report a problem"
// screen can attach real logs. Install before anything else so early errors
// (storage open, auth bootstrap) are recorded.
installConsoleCapture();

// Start crash & error monitoring as early as possible — a no-op until a DSN is
// configured (see observability/sentry-config).
initSentry();

// Hold the native splash until the hero wordmark fonts are ready, so the title
// never flashes from the system font to Gothic A1 / Gowun Dodum on first paint.
SplashScreen.preventAutoHideAsync().catch(() => {});

// The navigator lives in its own component so it can read the active locale
// from `I18nProvider` (a hook can't run in the same component that mounts the
// provider) and translate the Stack header titles.
function RootStack() {
  const t = useT();
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen name="add" options={{ title: t('nav.addBookmark'), presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ title: t('nav.settings') }} />
      <Stack.Screen name="account" options={{ title: t('nav.account'), presentation: 'modal' }} />
      <Stack.Screen name="review" options={{ title: t('nav.review') }} />
      <Stack.Screen name="report" options={{ title: t('nav.report') }} />
      <Stack.Screen name="archived" options={{ title: t('nav.archived') }} />
      <Stack.Screen name="bookmark/[id]" options={{ title: t('nav.bookmark') }} />
    </Stack>
  );
}

function RootLayout() {
  const colorScheme = useColorScheme();

  // Hero wordmark fonts: Gothic A1 for "Stash", Gowun Dodum for the native
  // wordmark (e.g. 스태시). Loaded once at the root and referenced by family
  // name in the Inbox hero.
  const [fontsLoaded, fontError] = useFonts({
    GothicA1_800ExtraBold,
    GothicA1_700Bold,
    GowunDodum_400Regular,
  });

  // Reveal the app once fonts resolve. A load *error* still releases the splash
  // (and falls back to the system font) so a font hiccup can never brick boot.
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <I18nProvider>
            <SupabaseAuthProvider>
              <BookmarksProvider>
                <CaptureToastProvider>
                  <ShareIntentHandler />
                  <RootStack />
                  <StatusBar style="auto" />
                </CaptureToastProvider>
              </BookmarksProvider>
            </SupabaseAuthProvider>
          </I18nProvider>
        </ThemeProvider>
      </ShareIntentProvider>
    </SafeAreaProvider>
  );
}

// Wrap the root so unhandled errors anywhere in the tree are captured.
export default wrapWithSentry(RootLayout);
