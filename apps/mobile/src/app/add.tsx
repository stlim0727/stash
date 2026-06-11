import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/theme';

export default function AddBookmarkScreen() {
  const palette = usePalette();
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: palette.textSecondary }]}>URL</Text>
      <TextInput
        style={[styles.input, { backgroundColor: palette.card, color: palette.text }]}
        placeholder="https://"
        placeholderTextColor={palette.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
      />
      <Text style={[styles.label, { color: palette.textSecondary }]}>Note (optional)</Text>
      <TextInput
        style={[styles.input, styles.noteInput, { backgroundColor: palette.card, color: palette.text }]}
        placeholder="Why are you saving this?"
        placeholderTextColor={palette.textSecondary}
        multiline
        value={note}
        onChangeText={setNote}
      />
      <Pressable
        style={[styles.saveButton, { backgroundColor: palette.accent }]}
        onPress={() => router.back()}
      >
        <Text style={styles.saveButtonLabel}>Save</Text>
      </Pressable>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>
        Saving is a placeholder for now. Local-first bookmark creation arrives in Milestone 3.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
  },
  noteInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  saveButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  saveButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
