import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';

export default function BookmarkDetailScreen() {
  const palette = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();

  const fields = [
    { label: 'URL', value: 'https://example.com/welcome' },
    { label: 'Title', value: 'Welcome to Stash' },
    { label: 'Description', value: 'Placeholder description until metadata enrichment exists.' },
    { label: 'Notes', value: 'Placeholder note field.' },
    { label: 'Tags', value: 'None yet' },
    { label: 'Collection', value: 'Inbox' },
    { label: 'Metadata status', value: 'pending' },
    { label: 'Bookmark ID', value: id ?? 'unknown' },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {fields.map((field) => (
        <View key={field.label} style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>{field.label}</Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>{field.value}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Text style={[styles.actionPlaceholder, { color: palette.textSecondary }]}>
          Archive and delete actions arrive in Milestone 10.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  field: {
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 15,
  },
  actions: {
    paddingVertical: 8,
  },
  actionPlaceholder: {
    fontSize: 13,
    textAlign: 'center',
  },
});
