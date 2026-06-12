import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { useColorScheme } from 'react-native';

import { ShareIntentHandler } from '@/share/share-intent-handler';
import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ShareIntentProvider options={{ debug: false, resetOnBackground: true }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <SupabaseAuthProvider>
          <BookmarksProvider>
            <ShareIntentHandler />
            <Stack>
              <Stack.Screen name="index" options={{ title: 'Inbox' }} />
              <Stack.Screen
                name="add"
                options={{ title: 'Add Bookmark', presentation: 'modal' }}
              />
              <Stack.Screen name="settings" options={{ title: 'Settings' }} />
              <Stack.Screen name="archived" options={{ title: 'Archived' }} />
              <Stack.Screen name="bookmark/[id]" options={{ title: 'Bookmark' }} />
            </Stack>
            <StatusBar style="auto" />
          </BookmarksProvider>
        </SupabaseAuthProvider>
      </ThemeProvider>
    </ShareIntentProvider>
  );
}
