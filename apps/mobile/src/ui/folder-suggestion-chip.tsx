/**
 * Shared rendering for an AI folder suggestion, used by both the Review screen
 * and the Bookmark Detail screen so a "move" (the bookmark is already in a
 * different collection) reads identically on both:
 *
 *   ADD     →  📁 → {name}             (file an un-filed bookmark in)
 *   CHANGE  →  📁 ~~{from}~~ → {name}   (relocate it out of `from`)
 *
 * The strikethrough is a real `textDecorationLine: 'line-through'` run (never
 * literal `~~`), so screen readers get a separate, spelled-out a11y label.
 */
import { StyleSheet, Text } from 'react-native';

import type { TFunction } from '@/i18n/translate';
import type { SuggestedFolder } from '@/domain/ai-suggestions';

/** The a11y label for a folder-suggestion chip, by ADD/CHANGE × existing/create. */
export function folderChipA11yLabel(
  t: TFunction,
  folder: SuggestedFolder,
  title: string,
): string {
  const from = folder.from?.name;
  if (folder.kind === 'existing') {
    return from
      ? t('review.moveFolderA11y', { title, from, name: folder.name })
      : t('review.acceptFolderA11y', { title, name: folder.name });
  }
  return from
    ? t('review.moveCreateFolderA11y', { title, from, name: folder.name })
    : t('review.createFolderA11y', { title, name: folder.name });
}

/**
 * The visible chip label as nested `<Text>` runs. For a move, the `from` name is
 * struck through (in `secondaryColor`) and the arrow + target are tinted
 * (`accentColor`); the arrow/target are never struck. For an add it's the plain
 * existing/create copy. Rendered inside a parent `<Text>` provided by the caller
 * so the runs stay on one line and inherit the chip's base style.
 */
export function FolderSuggestionLabel({
  t,
  folder,
  accentColor,
  secondaryColor,
}: {
  t: TFunction;
  folder: SuggestedFolder;
  accentColor: string;
  secondaryColor: string;
}) {
  const from = folder.from?.name;
  if (!from) {
    // ADD: plain existing/create copy (unchanged from the prior chip).
    return (
      <Text style={{ color: accentColor }}>
        {folder.kind === 'existing'
          ? t('review.folderAddArrow', { name: folder.name })
          : t('review.folderCreateArrow', { name: folder.name })}
      </Text>
    );
  }
  // CHANGE (move): 📁 ~~{from}~~ → {target}. The folder icon leads, the from
  // name is struck, then the tinted arrow + target.
  const target =
    folder.kind === 'existing'
      ? t('review.moveArrowTarget', { name: folder.name })
      : t('review.moveCreateTarget', { name: folder.name });
  return (
    <Text style={{ color: accentColor }}>
      {'📁 '}
      <Text style={[styles.struck, { color: secondaryColor }]}>{from}</Text>
      {' '}
      <Text style={{ color: accentColor }}>{target}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  struck: {
    textDecorationLine: 'line-through',
  },
});
