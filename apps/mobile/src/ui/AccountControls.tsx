import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { OAuthProvider } from '@/supabase/types';

const PROVIDERS: { id: OAuthProvider; label: string }[] = [
  { id: 'apple', label: 'Sign in with Apple' },
  { id: 'google', label: 'Sign in with Google' },
];

/**
 * Self-contained account/auth UI shared by the Account modal and Settings.
 * Renders provider sign-in when anonymous, account details + sign out when
 * authenticated, and a short note when the cloud isn't configured.
 */
export function AccountControls({ onDone }: { onDone?: () => void }) {
  const palette = usePalette();
  const auth = useSupabaseAuth();
  const [busy, setBusy] = useState<OAuthProvider | 'signout' | null>(null);

  const handleSignIn = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      const session = await auth.signIn(provider);
      if (session) {
        onDone?.();
      }
    } catch (error) {
      Alert.alert(
        'Sign in failed',
        error instanceof Error ? error.message : 'Could not complete sign in.',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleSignOut = async () => {
    setBusy('signout');
    try {
      await auth.signOut();
      onDone?.();
    } finally {
      setBusy(null);
    }
  };

  if (auth.status === 'not_configured') {
    return (
      <Text style={[styles.note, { color: palette.textSecondary }]}>
        Cloud sync isn’t configured on this build, so account sign-in is
        unavailable. Stash still works fully offline.
      </Text>
    );
  }

  if (auth.status === 'authenticated') {
    return (
      <View style={styles.group}>
        <Text style={[styles.heading, { color: palette.text }]}>
          {auth.email ? `Signed in as ${auth.email}` : 'Signed in'}
        </Text>
        <Text style={[styles.subheading, { color: palette.textSecondary }]}>
          Your bookmarks sync to this account across devices.
        </Text>
        <Button variant="ghost" size="lg" disabled={busy !== null} onPress={() => void handleSignOut()}>
          {busy === 'signout' ? <ActivityIndicator color={palette.text} /> : 'Sign out'}
        </Button>
      </View>
    );
  }

  // anonymous / loading / error — offer sign-in.
  return (
    <View style={styles.group}>
      <Text style={[styles.heading, { color: palette.text }]}>Sign in to sync across devices</Text>
      <Text style={[styles.subheading, { color: palette.textSecondary }]}>
        You’re browsing anonymously. Sign in to back up your stash and keep it in
        sync — your current bookmarks come with you.
      </Text>
      {PROVIDERS.map(({ id, label }) => (
        <Button
          key={id}
          variant="ghost"
          size="lg"
          accessibilityLabel={label}
          disabled={busy !== null}
          onPress={() => void handleSignIn(id)}
        >
          {busy === id ? <ActivityIndicator color={palette.text} /> : label}
        </Button>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: 12,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
  },
  subheading: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  note: {
    fontSize: 14,
    lineHeight: 20,
  },
});
