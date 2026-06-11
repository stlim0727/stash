import { StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';

const settingsRows = [
  {
    label: 'Account',
    value: 'Anonymous (sign-in arrives with Supabase auth in Milestone 5)',
  },
  {
    label: 'Sync status',
    value: 'Local only (cloud sync arrives in Milestone 7)',
  },
];

export default function SettingsScreen() {
  const palette = usePalette();

  return (
    <View style={styles.container}>
      {settingsRows.map((row) => (
        <View key={row.label} style={[styles.row, { backgroundColor: palette.card }]}>
          <Text style={[styles.rowLabel, { color: palette.text }]}>{row.label}</Text>
          <Text style={[styles.rowValue, { color: palette.textSecondary }]}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
});
