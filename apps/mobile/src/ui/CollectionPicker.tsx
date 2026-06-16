import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/theme';
import { normalizeTag } from '@/domain/tag-input';

export interface PickableCollection {
  id: string;
  name: string;
}

interface CollectionPickerProps {
  collections: PickableCollection[];
  currentId: string | null;
  currentName: string | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
  /**
   * Create a new collection by name and file the bookmark into it. Returns
   * false to indicate failure, so the picker stays open with the query intact.
   */
  onCreate: (name: string) => boolean | void | Promise<boolean | void>;
}

/**
 * A single row showing the current collection that expands into a search box
 * which doubles as "create": type a name with no match and a "Create" row
 * appears. Replaces the always-open chip grid + separate create form.
 */
export function CollectionPicker({
  collections,
  currentId,
  currentName,
  busy,
  onSelect,
  onCreate,
}: CollectionPickerProps) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    if (!trimmed) {
      return collections;
    }
    const key = normalizeTag(trimmed);
    return collections.filter((collection) => normalizeTag(collection.name).includes(key));
  }, [collections, trimmed]);
  const exactMatch = collections.some(
    (collection) => normalizeTag(collection.name) === normalizeTag(trimmed),
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={styles.wrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change collection"
        disabled={busy}
        onPress={() => setOpen((value) => !value)}
        style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.border }]}
      >
        <Text style={[styles.rowValue, { color: palette.text }]} numberOfLines={1}>
          {'📁  ' + (currentName ?? 'Inbox')}
        </Text>
        <Text style={[styles.chevron, { color: palette.textSecondary }]}>{open ? '▾' : '›'}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <TextInput
            accessibilityLabel="Find or create a collection"
            style={[styles.search, { color: palette.text, borderColor: palette.border }]}
            placeholder="Find or create…"
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            value={query}
            onChangeText={setQuery}
          />

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              onSelect(null);
              close();
            }}
            style={styles.option}
          >
            <Text style={[styles.optionLabel, { color: palette.text }]}>Inbox (none)</Text>
            {currentId === null ? <Text style={{ color: palette.accent }}>✓</Text> : null}
          </Pressable>

          {filtered.map((collection) => (
            <Pressable
              key={collection.id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                onSelect(collection.id);
                close();
              }}
              style={styles.option}
            >
              <Text style={[styles.optionLabel, { color: palette.text }]} numberOfLines={1}>
                {collection.name}
              </Text>
              {currentId === collection.id ? <Text style={{ color: palette.accent }}>✓</Text> : null}
            </Pressable>
          ))}

          {trimmed.length > 0 && !exactMatch ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Create collection ${trimmed}`}
              disabled={busy}
              onPress={async () => {
                // Only collapse/clear once the create succeeds; on failure keep
                // the picker open with the typed name so the user can retry.
                const result = await onCreate(trimmed);
                if (result !== false) {
                  close();
                }
              }}
              style={styles.option}
            >
              <Text style={[styles.optionLabel, { color: palette.accent }]} numberOfLines={1}>
                ＋ Create “{trimmed}”
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  rowValue: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  chevron: {
    fontSize: 18,
    fontWeight: '600',
    marginLeft: 8,
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 8,
    gap: 2,
  },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    fontSize: 15,
    marginBottom: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  optionLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
});
