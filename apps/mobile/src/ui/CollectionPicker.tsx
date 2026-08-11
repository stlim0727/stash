import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PostHogMaskView } from 'posthog-react-native';

import { useT } from '@/i18n';
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
  const t = useT();
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
        accessibilityLabel={t('collectionPicker.changeA11y')}
        disabled={busy}
        onPress={() => setOpen((value) => !value)}
        style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.border }]}
      >
        <PostHogMaskView style={styles.maskFlex}>
          <Text style={[styles.rowValue, { color: palette.text }]} numberOfLines={1}>
            {t('collectionPicker.current', { name: currentName ?? t('collectionPicker.inbox') })}
          </Text>
        </PostHogMaskView>
        <Text style={[styles.chevron, { color: palette.textSecondary }]}>{open ? '▾' : '›'}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <TextInput
            accessibilityLabel={t('collectionPicker.findOrCreateA11y')}
            style={[styles.search, { color: palette.text, borderColor: palette.border }]}
            placeholder={t('collectionPicker.findOrCreatePlaceholder')}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            value={query}
            onChangeText={setQuery}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('collectionPicker.inboxA11y')}
            disabled={busy}
            onPress={() => {
              onSelect(null);
              close();
            }}
            style={styles.option}
          >
            <Ionicons
              name="file-tray-outline"
              size={18}
              color={palette.textSecondary}
              style={styles.optionIcon}
            />
            <Text style={[styles.optionLabel, { color: palette.text }]}>{t('collectionPicker.inboxNone')}</Text>
            {currentId === null ? <Text style={{ color: palette.accent }}>✓</Text> : null}
          </Pressable>

          {filtered.map((collection) => (
            <Pressable
              key={collection.id}
              accessibilityRole="button"
              // PostHogMaskView below forces its own wrapper accessibilityLabel
              // ("ph-no-capture"), which would otherwise replace this row's
              // auto content-derived accessible name — restore it explicitly.
              accessibilityLabel={collection.name}
              disabled={busy}
              onPress={() => {
                onSelect(collection.id);
                close();
              }}
              style={styles.option}
            >
              <Ionicons
                name="folder-outline"
                size={18}
                color={palette.textSecondary}
                style={styles.optionIcon}
              />
              <PostHogMaskView style={styles.maskFlex}>
                <Text style={[styles.optionLabel, { color: palette.text }]} numberOfLines={1}>
                  {collection.name}
                </Text>
              </PostHogMaskView>
              {currentId === collection.id ? <Text style={{ color: palette.accent }}>✓</Text> : null}
            </Pressable>
          ))}

          {trimmed.length > 0 && !exactMatch ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('collectionPicker.createA11y', { name: trimmed })}
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
              <PostHogMaskView style={styles.maskFlex}>
                <Text style={[styles.optionLabel, { color: palette.accent }]} numberOfLines={1}>
                  {t('collectionPicker.create', { name: trimmed })}
                </Text>
              </PostHogMaskView>
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
  // Applied to the PostHogMaskView wrapping rowValue/optionLabel Text below —
  // their own `flex: 1` no longer sizes the row once nested inside an
  // unstyled wrapper View; the flex must live on the wrapper itself.
  maskFlex: {
    flex: 1,
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
  optionIcon: {
    marginRight: 10,
  },
  optionLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
});
