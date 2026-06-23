import Constants from 'expo-constants';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { I18nProvider, useT } from '@/i18n';
import { initSentry, wrapWithSentry } from '@/observability/sentry';
import { installConsoleCapture } from '@/observability/log-buffer';
import { compareSemver } from '@/domain/version';
import { ShareConfirmHandler } from '@/share/share-confirm-handler';
import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';
import { useMinAppVersion } from '@/supabase/use-min-app-version';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { UpdateRequired } from '@/ui/UpdateRequired';

// Capture console output into an in-memory buffer so the "Report a problem"
// screen can attach real logs. Install before anything else so early errors
// (storage open, auth bootstrap) are recorded.
installConsoleCapture();

// Start crash & error monitoring as early as possible — a no-op until a DSN is
// configured (see observability/sentry-config).
initSentry();

// The navigator lives in its own component so it can read the active locale
// from `I18nProvider` (a hook can't run in the same component that mounts the
// provider) and translate the Stack header titles.
function RootStack() {
  const t = useT();
  const minVersion = useMinAppVersion();
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';

  if (minVersion !== null && compareSemver(appVersion, minVersion) < 0) {
    return <UpdateRequired />;
  }

  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen name="add" options={{ title: t('nav.addBookmark'), presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ title: t('nav.settings') }} />
      <Stack.Screen name="account" options={{ title: t('nav.account'), presentation: 'modal' }} />
      <Stack.Screen name="review" options={{ title: t('nav.review') }} />
      <Stack.Screen name="report" options={{ title: t('nav.report') }} />
      <Stack.Screen name="api-keys" options={{ title: t('nav.apiKeys') }} />
      <Stack.Screen name="trash" options={{ title: t('nav.trash') }} />
      <Stack.Screen name="bookmark/[id]" options={{ title: t('nav.bookmark') }} />
    </Stack>
  );
}

function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaProvider>
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <I18nProvider>
            <SupabaseAuthProvider>
              <BookmarksProvider>
                <CaptureToastProvider>
                  <ShareIntentHandler />
                  <ShareConfirmHandler />
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
