import Constants from 'expo-constants';
import { Link } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { OAuthProvider } from '@/supabase/types';

export default function SettingsScreen() {
  const palette = usePalette();
  const [authBusy, setAuthBusy] = useState<OAuthProvider | 'signout' | null>(null);
  const {
    queue,
    isSyncing,
    syncNow,
    inbox,
    archived,
    lastPulledAt,
    getTagsForBookmark,
    getEnrichment,
  } = useBookmarks();
  const auth = useSupabaseAuth();

  // Total high-confidence, un-applied suggestions waiting in the review queue.
  const pendingSuggestionCount = inbox.reduce((total, bookmark) => {
    const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
    return total + pendingSuggestions(getEnrichment(bookmark.id), applied).length;
  }, 0);

  const waiting = queue.filter(
    (entry) => entry.sync_status === 'pending' || entry.sync_status === 'failed',
  ).length;
  // Sync is upload-then-pull, so it is useful even with nothing to upload
  // (another device or cloud AI enrichment may have changed data).
  const canSync = auth.isSignedIn && !isSyncing;

  const syncValue = isSyncing
    ? `Syncing ${waiting} item(s)…`
    : waiting === 0
      ? auth.isSignedIn
        ? 'Synced — nothing waiting to upload'
        : 'Local only — nothing waiting to sync'
      : auth.isSignedIn
        ? `${waiting} item(s) waiting to upload`
        : `Local only — ${waiting} item(s) queued until Supabase is available`;

  const isAuthenticated = auth.status === 'authenticated';

  const accountValue = isAuthenticated
    ? `Signed in${auth.email ? ` as ${auth.email}` : ''}`
    : auth.status === 'anonymous'
      ? `Anonymous Supabase user ${auth.userId}`
      : auth.message;

  const handleSignIn = async (provider: OAuthProvider) => {
    setAuthBusy(provider);
    try {
      await auth.signIn(provider);
    } catch (error) {
      Alert.alert(
        'Sign in failed',
        error instanceof Error ? error.message : 'Could not complete sign in.',
      );
    } finally {
      setAuthBusy(null);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy('signout');
    try {
      await auth.signOut();
    } finally {
      setAuthBusy(null);
    }
  };

  const settingsRows = [
    {
      label: 'Account',
      value: accountValue,
    },
    {
      label: 'Sync status',
      value: syncValue,
    },
    {
      label: 'Supabase auth',
      value: auth.status,
    },
    {
      label: 'Last pulled',
      value: lastPulledAt
        ? new Date(lastPulledAt).toLocaleString()
        : 'Never — remote changes arrive on the next sync',
    },
    {
      label: 'App version',
      value: `${Constants.expoConfig?.version ?? '0.0.0'} (Expo SDK ${
        Constants.expoConfig?.sdkVersion ?? '56'
      })`,
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {settingsRows.map((row) => (
        <View key={row.label} style={[styles.row, { backgroundColor: palette.card }]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>{row.label}</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>{row.value}</Text>
        </View>
      ))}

      {auth.status === 'not_configured' ? null : isAuthenticated ? (
        <Pressable
          accessibilityRole="button"
          disabled={authBusy !== null}
          style={[styles.authButton, { borderColor: palette.border, opacity: authBusy ? 0.6 : 1 }]}
          onPress={() => void handleSignOut()}
        >
          {authBusy === 'signout' ? (
            <ActivityIndicator color={palette.text} />
          ) : (
            <Text style={[styles.authButtonLabel, { color: palette.text }]}>Sign out</Text>
          )}
        </Pressable>
      ) : (
        <View style={styles.authGroup}>
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            Sign in to sync across devices
          </Text>
          {(['apple', 'google'] as const).map((provider) => (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityLabel={`Sign in with ${provider === 'apple' ? 'Apple' : 'Google'}`}
              disabled={authBusy !== null}
              style={[
                styles.authButton,
                { borderColor: palette.border, opacity: authBusy ? 0.6 : 1 },
              ]}
              onPress={() => void handleSignIn(provider)}
            >
              {authBusy === provider ? (
                <ActivityIndicator color={palette.text} />
              ) : (
                <Text style={[styles.authButtonLabel, { color: palette.text }]}>
                  {provider === 'apple' ? 'Sign in with Apple' : 'Sign in with Google'}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      )}

      <Link href="/review" asChild>
        <Pressable style={[styles.row, { backgroundColor: palette.card }]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Review AI suggestions</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            {pendingSuggestionCount > 0
              ? `${pendingSuggestionCount} suggestion${pendingSuggestionCount > 1 ? 's' : ''} to review ›`
              : 'Nothing to review right now ›'}
          </Text>
        </Pressable>
      </Link>

      <Link href="/archived" asChild>
        <Pressable style={[styles.row, { backgroundColor: palette.card }]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Library</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            {`${inbox.length} in inbox · ${archived.length} archived — view archived ›`}
          </Text>
        </Pressable>
      </Link>

      <Link href="/report" asChild>
        <Pressable style={[styles.row, { backgroundColor: palette.card }]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Report a problem</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            Send a bug or idea with diagnostic context ›
          </Text>
        </Pressable>
      </Link>

      {canSync ? (
        <Pressable
          style={[styles.syncButton, { backgroundColor: palette.accent }]}
          onPress={() => void syncNow()}
        >
          <Text style={styles.syncButtonLabel}>Sync now</Text>
        </Pressable>
      ) : null}

      <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
        Pending sync queue
      </Text>
      {queue.length === 0 ? (
        <Text style={[styles.emptyQueue, { color: palette.textSecondary }]}>
          The offline queue is empty.
        </Text>
      ) : (
        queue.map((entry) => (
          <View key={entry.local_id} style={[styles.row, { backgroundColor: palette.card }]}>
            <Text style={[styles.rowLabel, { color: palette.text }]} numberOfLines={1}>
              {entry.payload.url ?? entry.payload.shared_text ?? entry.local_id}
            </Text>
            <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
              {`${entry.operation} · status ${entry.sync_status} · retries ${entry.retry_count}`}
              {entry.last_error ? `\nlast error: ${entry.last_error}` : ''}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  row: {
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  rowValue: {
    fontSize: 14,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
  },
  emptyQueue: {
    fontSize: 14,
  },
  syncButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  syncButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  authGroup: {
    gap: 12,
  },
  authButton: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    alignItems: 'center',
  },
  authButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
