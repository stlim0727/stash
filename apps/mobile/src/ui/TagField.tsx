import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useT } from '@/i18n';
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

/**
 * A folder (collection) recommendation rendered as the leading chip of the
 * suggestion row, alongside the tag suggestions — a folder is conceptually just
 * a tag you can only hold one of, so it lives in the same group and is swept by
 * the same "Add all"/"Dismiss all". The caller supplies the rendered label
 * (e.g. a FolderSuggestionLabel) and the accept/dismiss handlers.
 */
export interface FolderSuggestionChip {
  label: ReactNode;
  acceptA11y: string;
  dismissA11y: string;
  onAccept: () => void;
  onDismiss: () => void;
}

interface TagFieldProps {
  tags: AppliedTag[];
  suggestions: TagSuggestion[];
  /** False when the bookmark can't be organized yet (e.g. not synced). */
  editable: boolean;
  busy: boolean;
  /** Returns false to indicate the add failed, so the typed text is kept. */
  onAdd: (name: string) => boolean | void | Promise<boolean | void>;
  onRemove: (name: string) => void;
  onBrowse: (tagId: string) => void;
  onAcceptSuggestion: (name: string) => void;
  onDismissSuggestion: (name: string) => void;
  /** Accept every current suggestion at once (mirror of "dismiss all"). */
  onAcceptAllSuggestions?: () => void;
  /** Dismiss every current suggestion at once (the low-effort escape hatch). */
  onDismissAllSuggestions?: () => void;
  /**
   * A folder recommendation shown as the leading chip of the suggestion row.
   * It's counted toward the "Add all"/"Dismiss all" threshold and swept by them,
   * so folder + tags read as one group — matching the Review screen.
   */
  folderSuggestion?: FolderSuggestionChip | null;
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
  onAcceptAllSuggestions,
  onDismissAllSuggestions,
  folderSuggestion,
  disabledHint,
}: TagFieldProps) {
  const palette = usePalette();
  const t = useT();
  const [value, setValue] = useState('');

  // The folder chip leads the suggestion row; tags follow. The row shows when
  // there's anything to suggest, and the bulk "Add all"/"Dismiss all" appears
  // once that's more than one thing (folder + tags), since they sweep both.
  const hasFolderSuggestion = !!folderSuggestion;
  const bulkCount = suggestions.length + (hasFolderSuggestion ? 1 : 0);
  const showSuggestionRow = suggestions.length > 0 || hasFolderSuggestion;

  const commit = async (raw: string) => {
    const name = raw.trim();
    if (!name || isDuplicateTag(name, tags.map((tag) => tag.name))) {
      return;
    }
    // Keep the typed text if the add fails (e.g. offline / sync error) so the
    // user doesn't lose it and can retry, rather than clearing optimistically.
    const result = await onAdd(name);
    if (result === false) {
      setValue((current) => (current.length === 0 ? name : current));
    }
  };

  const handleChange = (text: string) => {
    const { commit: committed, rest } = readTagInput(text);
    setValue(rest);
    if (committed !== null) {
      void commit(committed);
    }
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
              accessibilityLabel={t('tagField.browseA11y', { name: tag.name })}
              onPress={() => onBrowse(tag.id)}
            >
              <Text style={[styles.chipLabel, { color: palette.accentText }]}>{tag.name}</Text>
            </Pressable>
            {editable ? (
              <Pressable
                accessibilityLabel={t('tagField.removeA11y', { name: tag.name })}
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
            accessibilityLabel={t('tagField.addTagA11y')}
            style={[styles.input, { color: palette.text }]}
            placeholder={tags.length === 0 ? t('tagField.placeholderEmpty') : t('tagField.placeholderMore')}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            value={value}
            editable={!busy}
            onChangeText={handleChange}
            onKeyPress={(event) => handleKeyPress(event.nativeEvent.key)}
            onSubmitEditing={() => {
              const token = value;
              setValue('');
              void commit(token);
            }}
            blurOnSubmit={false}
            returnKeyType="done"
          />
        ) : tags.length === 0 ? (
          <Text style={[styles.placeholder, { color: palette.textSecondary }]}>
            {disabledHint ?? t('tagField.noTags')}
          </Text>
        ) : null}
      </View>

      {!editable && disabledHint && tags.length > 0 ? (
        <Text style={[styles.hint, { color: palette.textSecondary }]}>{disabledHint}</Text>
      ) : null}

      {showSuggestionRow ? (
        <View style={styles.suggestionRow}>
          {folderSuggestion ? (
            <View style={[styles.ghostChip, { borderColor: palette.accent }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={folderSuggestion.acceptA11y}
                disabled={busy}
                onPress={folderSuggestion.onAccept}
              >
                {/* The label brings its own colors (file-in vs. move), so the
                    wrapper Text sets none — unlike the accent tag chips below. */}
                <Text style={styles.ghostLabel}>{folderSuggestion.label}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={folderSuggestion.dismissA11y}
                disabled={busy}
                hitSlop={6}
                onPress={folderSuggestion.onDismiss}
              >
                <Text style={[styles.ghostRemove, { color: palette.textSecondary }]}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {suggestions.map((suggestion) => (
            <View key={suggestion.name} style={[styles.ghostChip, { borderColor: palette.accent }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('tagField.acceptSuggestionA11y', { name: suggestion.name })}
                disabled={busy}
                onPress={() => onAcceptSuggestion(suggestion.name)}
              >
                <Text style={[styles.ghostLabel, { color: palette.accent }]}>
                  ＋ {suggestion.name}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('tagField.dismissSuggestionA11y', { name: suggestion.name })}
                disabled={busy}
                hitSlop={6}
                onPress={() => onDismissSuggestion(suggestion.name)}
              >
                <Text style={[styles.ghostRemove, { color: palette.textSecondary }]}>✕</Text>
              </Pressable>
            </View>
          ))}
          {onAcceptAllSuggestions && bulkCount > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('tagField.addAllA11y')}
              disabled={busy}
              hitSlop={6}
              style={styles.bulkAction}
              onPress={onAcceptAllSuggestions}
            >
              <Ionicons name="checkmark-done-outline" size={14} color={palette.accent} />
              <Text style={[styles.bulkActionLabel, { color: palette.accent }]}>
                {t('tagField.addAll')}
              </Text>
            </Pressable>
          ) : null}
          {onDismissAllSuggestions && bulkCount > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('tagField.dismissAllA11y')}
              disabled={busy}
              hitSlop={6}
              style={styles.bulkAction}
              onPress={onDismissAllSuggestions}
            >
              <Ionicons name="close-circle-outline" size={14} color={palette.textSecondary} />
              <Text style={[styles.bulkActionLabel, { color: palette.textSecondary }]}>
                {t('tagField.dismissAll')}
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
  bulkAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    justifyContent: 'center',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  bulkActionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
