import Constants from 'expo-constants';
import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';

export default function SettingsScreen() {
  const palette = usePalette();
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
  const canSync = auth.status === 'anonymous' && !isSyncing;

  const syncValue = isSyncing
    ? `Syncing ${waiting} item(s)…`
    : waiting === 0
      ? auth.status === 'anonymous'
        ? 'Synced — nothing waiting to upload'
        : 'Local only — nothing waiting to sync'
      : auth.status === 'anonymous'
        ? `${waiting} item(s) waiting to upload`
        : `Local only — ${waiting} item(s) queued until Supabase is available`;

  const settingsRows = [
    {
      label: 'Account',
      value:
        auth.status === 'anonymous'
          ? `Anonymous Supabase user ${auth.userId}`
          : auth.message,
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
    <ScrollView style={{ backgroundColor: palette.background }} contentContainerStyle={styles.container}>
      <View style={styles.hero}>
        <Text style={[styles.heroTitle, { color: palette.text }]}>Settings</Text>
        <Text style={[styles.heroSubtitle, { color: palette.textSecondary }]}>
          Manage your library, sync, and support options.
        </Text>
      </View>
      {settingsRows.map((row) => (
        <Card key={row.label} style={styles.row}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>{row.label}</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>{row.value}</Text>
        </Card>
      ))}

      <Link href="/review" asChild>
        <Pressable style={({ pressed }) => [styles.row, { backgroundColor: palette.surfaceElevated, borderColor: palette.border, opacity: pressed ? 0.78 : 1 }, palette.shadow.soft]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Review AI suggestions</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            {pendingSuggestionCount > 0
              ? `${pendingSuggestionCount} suggestion${pendingSuggestionCount > 1 ? 's' : ''} to review ›`
              : 'Nothing to review right now ›'}
          </Text>
        </Pressable>
      </Link>

      <Link href="/archived" asChild>
        <Pressable style={({ pressed }) => [styles.row, { backgroundColor: palette.surfaceElevated, borderColor: palette.border, opacity: pressed ? 0.78 : 1 }, palette.shadow.soft]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Library</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            {`${inbox.length} in inbox · ${archived.length} archived — view archived ›`}
          </Text>
        </Pressable>
      </Link>

      <Link href="/report" asChild>
        <Pressable style={({ pressed }) => [styles.row, { backgroundColor: palette.surfaceElevated, borderColor: palette.border, opacity: pressed ? 0.78 : 1 }, palette.shadow.soft]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>Report a problem</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
            Send a bug or idea with diagnostic context ›
          </Text>
        </Pressable>
      </Link>

      {canSync ? (
        <Button size="lg" onPress={() => void syncNow()}>Sync now</Button>
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
          <Card key={entry.local_id} style={styles.row}>
            <Text style={[styles.rowLabel, { color: palette.text }]} numberOfLines={1}>
              {entry.payload.url ?? entry.payload.shared_text ?? entry.local_id}
            </Text>
            <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
              {`${entry.operation} · status ${entry.sync_status} · retries ${entry.retry_count}`}
              {entry.last_error ? `\nlast error: ${entry.last_error}` : ''}
            </Text>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 14,
  },
  hero: {
    paddingVertical: 8,
  },
  heroTitle: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  heroSubtitle: {
    fontSize: 15,
    marginTop: 4,
  },
  row: {
    borderRadius: 22,
    padding: 18,
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
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
});
