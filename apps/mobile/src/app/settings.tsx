import Constants from 'expo-constants';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';

export default function SettingsScreen() {
  const palette = usePalette();
  const { queue, isSyncing, syncNow, inbox, archivedCount } = useBookmarks();
  const auth = useSupabaseAuth();

  const waiting = queue.filter(
    (entry) => entry.sync_status === 'pending' || entry.sync_status === 'failed',
  ).length;
  const canSync = auth.status === 'anonymous' && waiting > 0 && !isSyncing;

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
      label: 'Library',
      value: `${inbox.length} in inbox · ${archivedCount} archived`,
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
              {`status ${entry.sync_status} · retries ${entry.retry_count}`}
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
});
