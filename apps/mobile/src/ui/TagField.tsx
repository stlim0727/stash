import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/theme';
import { isDuplicateTag, readTagInput } from '@/domain/tag-input';

export interface AppliedTag {
  id: string;
  name: string;
}

export interface TagSuggestion {
  name: string;
  confidence: number;
}

interface TagFieldProps {
  tags: AppliedTag[];
  suggestions: TagSuggestion[];
  /** False when the bookmark can't be organized yet (e.g. not synced). */
  editable: boolean;
  busy: boolean;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onBrowse: (tagId: string) => void;
  onAcceptSuggestion: (name: string) => void;
  onDismissSuggestion: (name: string) => void;
  /** Shown in place of the input when not editable. */
  disabledHint?: string;
}

/**
 * Inline tag "token field": existing tags render as chips and the user types
 * straight into the row — space / comma / return commits a chip, backspace on
 * an empty input removes the last one. AI/other suggestions appear as tappable
 * "+chips" below. No separate Add button.
 */
export function TagField({
  tags,
  suggestions,
  editable,
  busy,
  onAdd,
  onRemove,
  onBrowse,
  onAcceptSuggestion,
  onDismissSuggestion,
  disabledHint,
}: TagFieldProps) {
  const palette = usePalette();
  const [value, setValue] = useState('');

  const commit = (raw: string) => {
    const name = raw.trim();
    if (!name || isDuplicateTag(name, tags.map((tag) => tag.name))) {
      return;
    }
    onAdd(name);
  };

  const handleChange = (text: string) => {
    const { commit: committed, rest } = readTagInput(text);
    if (committed !== null) {
      commit(committed);
    }
    setValue(rest);
  };

  const handleKeyPress = (key: string) => {
    if (key === 'Backspace' && value.length === 0 && tags.length > 0) {
      onRemove(tags[tags.length - 1]!.name);
    }
  };

  return (
    <View style={styles.wrapper}>
      <View
        style={[
          styles.field,
          { backgroundColor: palette.surface, borderColor: palette.border },
        ]}
      >
        {tags.map((tag) => (
          <View key={tag.id} style={[styles.chip, { backgroundColor: palette.accentSoft }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Browse #${tag.name}`}
              onPress={() => onBrowse(tag.id)}
            >
              <Text style={[styles.chipLabel, { color: palette.accentText }]}>{tag.name}</Text>
            </Pressable>
            {editable ? (
              <Pressable
                accessibilityLabel={`Remove tag ${tag.name}`}
                disabled={busy}
                hitSlop={6}
                onPress={() => onRemove(tag.name)}
              >
                <Text style={[styles.chipRemove, { color: palette.accentText }]}>✕</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {editable ? (
          <TextInput
            accessibilityLabel="Add a tag"
            style={[styles.input, { color: palette.text }]}
            placeholder={tags.length === 0 ? 'Add tags…' : 'Add…'}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            value={value}
            editable={!busy}
            onChangeText={handleChange}
            onKeyPress={(event) => handleKeyPress(event.nativeEvent.key)}
            onSubmitEditing={() => {
              commit(value);
              setValue('');
            }}
            blurOnSubmit={false}
            returnKeyType="done"
          />
        ) : tags.length === 0 ? (
          <Text style={[styles.placeholder, { color: palette.textSecondary }]}>
            {disabledHint ?? 'No tags yet'}
          </Text>
        ) : null}
      </View>

      {!editable && disabledHint && tags.length > 0 ? (
        <Text style={[styles.hint, { color: palette.textSecondary }]}>{disabledHint}</Text>
      ) : null}

      {suggestions.length > 0 ? (
        <View style={styles.suggestionRow}>
          {suggestions.map((suggestion) => (
            <View key={suggestion.name} style={[styles.ghostChip, { borderColor: palette.accent }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Accept suggested tag ${suggestion.name}`}
                disabled={busy}
                onPress={() => onAcceptSuggestion(suggestion.name)}
              >
                <Text style={[styles.ghostLabel, { color: palette.accent }]}>
                  ＋ {suggestion.name}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={`Dismiss suggested tag ${suggestion.name}`}
                disabled={busy}
                hitSlop={6}
                onPress={() => onDismissSuggestion(suggestion.name)}
              >
                <Text style={[styles.ghostRemove, { color: palette.textSecondary }]}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 10,
  },
  field: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 48,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
    includeFontPadding: false,
  },
  chipRemove: {
    fontSize: 12,
    fontWeight: '700',
  },
  input: {
    flexGrow: 1,
    minWidth: 80,
    fontSize: 15,
    paddingVertical: 4,
  },
  placeholder: {
    fontSize: 15,
    paddingVertical: 4,
  },
  hint: {
    fontSize: 13,
  },
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ghostChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderStyle: 'dashed',
  },
  ghostLabel: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    includeFontPadding: false,
  },
  ghostRemove: {
    fontSize: 12,
    fontWeight: '700',
  },
});
