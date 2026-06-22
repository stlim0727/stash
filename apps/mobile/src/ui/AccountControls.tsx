import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { OAuthProvider } from '@/supabase/types';

const PROVIDERS: { id: OAuthProvider; labelKey: MessageKey }[] = [
  { id: 'apple', labelKey: 'account.signInApple' },
  { id: 'google', labelKey: 'account.signInGoogle' },
];

/**
 * Self-contained account/auth UI used inline in Settings. Renders provider
 * sign-in when anonymous, account details + sign out when authenticated, and a
 * short note when the cloud isn't configured.
 *
 * In `compact` mode it drops the heading/subtitle (the surrounding Settings
 * card already shows the account status) and renders nothing when the cloud is
 * not configured, so it can sit directly beneath the account row.
 */
export function AccountControls({
  onDone,
  compact = false,
}: {
  onDone?: () => void;
  compact?: boolean;
}) {
  const palette = usePalette();
  const t = useT();
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
        t('account.signInFailedTitle'),
        error instanceof Error ? error.message : t('account.signInFailedBody'),
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
    if (compact) {
      return null;
    }
    return (
      <Text style={[styles.note, { color: palette.textSecondary }]}>
        {t('account.cloudNotConfigured')}
      </Text>
    );
  }

  if (auth.status === 'authenticated') {
    return (
      <View style={styles.group}>
        {compact ? null : (
          <>
            <Text style={[styles.heading, { color: palette.text }]}>
              {auth.email ? t('account.signedInAs', { email: auth.email }) : t('account.signedIn')}
            </Text>
            <Text style={[styles.subheading, { color: palette.textSecondary }]}>
              {t('account.syncSubtitle')}
            </Text>
          </>
        )}
        <Button variant="ghost" size="lg" disabled={busy !== null} onPress={() => void handleSignOut()}>
          {busy === 'signout' ? <ActivityIndicator color={palette.text} /> : t('common.signOut')}
        </Button>
      </View>
    );
  }

  // anonymous / loading / error — offer sign-in.
  return (
    <View style={styles.group}>
      {compact ? null : (
        <>
          <Text style={[styles.heading, { color: palette.text }]}>
            {t('account.signInHeading')}
          </Text>
          <Text style={[styles.subheading, { color: palette.textSecondary }]}>
            {t('account.signInSubtitle')}
          </Text>
        </>
      )}
      {PROVIDERS.map(({ id, labelKey }) => (
        <Button
          key={id}
          variant="ghost"
          size="lg"
          accessibilityLabel={t(labelKey)}
          disabled={busy !== null}
          onPress={() => void handleSignIn(id)}
        >
          {busy === id ? <ActivityIndicator color={palette.text} /> : t(labelKey)}
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
