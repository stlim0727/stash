/**
 * Pull hashtags out of captured content (Instagram captions, tweet text, …) so
 * they can be offered as ready-to-add tag suggestions. Many social posts already
 * carry the user's own taxonomy as `#tags` in the title/description; surfacing
 * them saves re-typing.
 *
 * Pure and dependency-light so it is unit-tested under the Node runner and the
 * detail screen stays a thin shell around it.
 */

/**
 * A `#` followed by one or more letters (any script — Korean, CJK, Latin, …),
 * digits, or underscores. The `u` flag makes `\p{L}`/`\p{N}` Unicode-aware so a
 * Korean tag like `#목살` is captured, not just ASCII.
 */
const HASHTAG_PATTERN = /#([\p{L}\p{N}_]+)/gu;

/** Tags must contain at least one letter, so noise like `#1` / `#2024` is dropped. */
const HAS_LETTER = /\p{L}/u;

/** Cap how many we surface; a spammy caption can carry dozens of hashtags. */
const MAX_HASHTAGS = 12;

/**
 * Extract distinct hashtag names (without the leading `#`) from the given text
 * fragments, in first-seen order. De-duplication is case-insensitive, the `#` is
 * stripped, purely-numeric tags are ignored, and the result is capped.
 */
export function extractHashtags(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(HASHTAG_PATTERN)) {
      const name = match[1];
      if (!HAS_LETTER.test(name)) {
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(name);
      if (result.length >= MAX_HASHTAGS) {
        return result;
      }
    }
  }

  return result;
}

/**
 * Hashtags worth suggesting for a bookmark: those present in its text but not
 * already applied as tags. `appliedTagNames` must be lower-cased.
 */
export function hashtagSuggestions(
  texts: (string | null | undefined)[],
  appliedTagNames: Set<string>,
): string[] {
  return extractHashtags(...texts).filter((name) => !appliedTagNames.has(name.toLowerCase()));
}
