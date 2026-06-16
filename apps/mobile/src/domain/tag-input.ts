/**
 * Pure helpers for the inline tag "token field": turning what the user types
 * into committed tag chips. Kept dependency-free so it is unit-tested under the
 * Node runner and the component stays a thin shell around it.
 */

/** A separator commits the token before it: space, comma, tab, or newline. */
const TRAILING_SEPARATOR = /[\s,]$/;

export interface TagCommit {
  /** A tag to commit, or null if the text is still being typed. */
  commit: string | null;
  /** The text that should remain in the input after handling. */
  rest: string;
}

/**
 * Given the input's latest value, decide whether the user just finished a tag
 * (by typing a separator) and what should stay in the field.
 */
export function readTagInput(value: string): TagCommit {
  if (TRAILING_SEPARATOR.test(value)) {
    const token = value.replace(/[\s,]+$/, '').trim();
    return { commit: token.length > 0 ? token : null, rest: '' };
  }
  return { commit: null, rest: value };
}

/** Normalize a tag for case-insensitive de-duplication (display keeps the input). */
export function normalizeTag(name: string): string {
  return name.trim().toLowerCase();
}

/** True when `name` is already present in `existing` (case-insensitive). */
export function isDuplicateTag(name: string, existing: readonly string[]): boolean {
  const key = normalizeTag(name);
  return existing.some((tag) => normalizeTag(tag) === key);
}
