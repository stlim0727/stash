import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { useBookmarks } from '@/store/bookmarks';

export default function SettingsScreen() {
  const palette = usePalette();
  const { queue } = useBookmarks();

  const settingsRows = [
    {
      label: 'Account',
      value: 'Anonymous (sign-in arrives with Supabase auth in Milestone 5)',
    },
    {
      label: 'Sync status',
      value:
        queue.length === 0
          ? 'Local only — nothing waiting to sync'
          : `Local only — ${queue.length} item(s) queued for future sync`,
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
});
