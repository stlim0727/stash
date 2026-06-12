import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

import { BookmarksProvider } from '@/store/bookmarks';
import { SupabaseAuthProvider } from '@/supabase/auth-provider';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <SupabaseAuthProvider>
        <BookmarksProvider>
          <Stack>
            <Stack.Screen name="index" options={{ title: 'Inbox' }} />
            <Stack.Screen
              name="add"
              options={{ title: 'Add Bookmark', presentation: 'modal' }}
            />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            <Stack.Screen name="bookmark/[id]" options={{ title: 'Bookmark' }} />
          </Stack>
          <StatusBar style="auto" />
        </BookmarksProvider>
      </SupabaseAuthProvider>
    </ThemeProvider>
  );
}
