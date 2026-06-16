import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { useBookmarks } from '@/store/bookmarks';

export default function AddBookmarkScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { addBookmark } = useBookmarks();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const result = addBookmark({ url, notes: note });
    if (result.status === 'invalid') {
      setError(result.error);
      return;
    }
    // Created or duplicate: the bookmark is already visible in Inbox,
    // so capture stays fast and non-blocking.
    router.back();
  }

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Card elevated={false} style={styles.captureCard}>
        <Text style={[styles.label, { color: palette.textSecondary }]}>URL</Text>
        <TextInput
          style={[styles.input, { backgroundColor: palette.card, color: palette.text }]}
          placeholder="https://"
          placeholderTextColor={palette.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="url"
          value={url}
          onChangeText={(value) => {
            setUrl(value);
            if (error) {
              setError(null);
            }
          }}
          onSubmitEditing={handleSave}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={[styles.label, { color: palette.textSecondary }]}>Note (optional)</Text>
        <TextInput
          style={[
            styles.input,
            styles.noteInput,
            { backgroundColor: palette.card, color: palette.text },
          ]}
          placeholder="Why are you saving this?"
          placeholderTextColor={palette.textSecondary}
          multiline
          value={note}
          onChangeText={setNote}
        />
      </Card>
      <Button size="lg" onPress={handleSave}>Save bookmark</Button>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>
        Saved instantly to your device and synced to the cloud in the background — capture never
        waits on the network.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 14,
  },
  captureCard: {
    borderRadius: 24,
    padding: 18,
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderRadius: 18,
    padding: 14,
    fontSize: 16,
  },
  noteInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  error: {
    color: '#d93636',
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
