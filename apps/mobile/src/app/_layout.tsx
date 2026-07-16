import Constants from 'expo-constants';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { I18nProvider, useT } from '@/i18n';
import { initSentry, wrapWithSentry } from '@/observability/sentry';
import { installConsoleCapture } from '@/observability/log-buffer';
import { installPwaHead } from '@/share/pwa-head';
import { compareSemver } from '@/domain/version';
import { hydrateShareDiagnostics } from '@/share/share-diagnostics';
import { ShareConfirmHandler } from '@/share/share-confirm-handler';
import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';
import { useAppConfig } from '@/supabase/use-min-app-version';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { FloatingReportButton } from '@/feedback/FloatingReportButton';
import { UpdateRequired } from '@/ui/UpdateRequired';

// Capture console output into an in-memory buffer so the "Report a problem"
// screen can attach real logs. Install before anything else so early errors
// (storage open, auth bootstrap) are recorded.
installConsoleCapture();

// Start crash & error monitoring as early as possible — a no-op until a DSN is
// configured (see observability/sentry-config).
initSentry();

// Inject the PWA <head> tags (manifest, theme color, apple-touch-icon) — needed
// on web because output:"single" (SPA) doesn't use the +html.tsx template. A
// no-op on native.
installPwaHead();

// Load the durable "last share attempt" record (if any) so a "Report a
// problem" filed this session can show what the most recent share contained,
// even when that share happened in a prior process instance. Best-effort — a
// report screen without it is still useful.
void hydrateShareDiagnostics();

// The native module's own durable "last share intent seen" breadcrumb
// (Android, Sentry STASH-2Q — see `hydrateNativeShareDebugLog`) is
// deliberately NOT read here: it uses read-and-clear semantics, and reading
// it at every startup would consume it during an ordinary app open that
// never leads to a report, losing it before a later report screen (in this
// session or a subsequent one) gets a chance to recover it. It's read only
// from the report screen itself, right when diagnostics are actually
// collected — native SharedPreferences already persists it across restarts
// on its own, so no startup-time hydration is needed.

// The navigator lives in its own component so it can read the active locale
// from `I18nProvider` (a hook can't run in the same component that mounts the
// provider) and translate the Stack header titles.
function RootStack() {
  const t = useT();
  const appConfig = useAppConfig();
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';

  if (appConfig.minAppVersion !== null && compareSemver(appVersion, appConfig.minAppVersion) < 0) {
    return <UpdateRequired message={appConfig.updateMessage} updateUrl={appConfig.updateUrl} />;
  }

  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen
        name="add"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <Stack.Screen
        name="settings"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <Stack.Screen
        name="review"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <Stack.Screen
        name="report"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <Stack.Screen name="trash" options={{ title: t('nav.trash') }} />
      <Stack.Screen
        name="browse/tags"
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <Stack.Screen name="graph" options={{ title: t('nav.graph') }} />
      <Stack.Screen name="bookmark/[id]" options={{ title: t('nav.bookmark') }} />
    </Stack>
  );
}

function RootLayout() {
  return (
    <SafeAreaProvider>
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
        <ThemeProvider value={DarkTheme}>
          <I18nProvider>
            <SupabaseAuthProvider>
              <BookmarksProvider>
                <CaptureToastProvider>
                  <ShareIntentHandler />
                  <ShareConfirmHandler />
                  <FloatingReportButton>
                    <RootStack />
                  </FloatingReportButton>
                  <StatusBar style="light" />
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
