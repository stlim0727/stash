/**
 * A `{ [key]: string[] }` map persisted as JSON in the repository meta store,
 * used wherever the app remembers a *set of strings per bookmark* — e.g. the AI
 * suggestion names a user has reviewed (`reviewed_ai_suggestions`) and the folder
 * suggestions they've dismissed (`dismissed_folder_suggestions`). Those two
 * carried near-identical parse/merge/lookup code; this is the one shared
 * implementation behind both (see `ai-suggestions.ts` for the semantic wrappers).
 *
 * Normalization is the *caller's* responsibility, passed to {@link addToStringSet}:
 * reviewed names are lowercased/trimmed at the boundary, folder tokens arrive
 * already folded (`suggestedFolderToken` lowercases the name half), so this
 * module stays value-agnostic and never mangles a token.
 */
export type StringSetMap = Record<string, string[]>;

/** Parse the JSON meta blob into a {@link StringSetMap}, tolerating
 *  malformed/legacy values (non-objects, non-string entries) by dropping them
 *  and returning a clean map (empty if the blob is unusable). */
export function parseStringSetMap(raw: string | null): StringSetMap {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: StringSetMap = {};
    for (const [key, values] of Object.entries(parsed)) {
      if (Array.isArray(values)) {
        result[key] = values.filter((value): value is string => typeof value === 'string');
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** The stored values for one key, as a Set (empty when the key is absent). */
export function stringSetFor(map: StringSetMap, key: string): Set<string> {
  return new Set(map[key] ?? []);
}

/**
 * Merge `values` into the set under `key`. Returns the SAME map reference when
 * nothing new was added (so callers can skip a re-persist / dirty check),
 * otherwise a new map with the (optionally normalized, deduped) values appended.
 * A value that normalizes to an empty string is skipped.
 */
export function addToStringSet(
  map: StringSetMap,
  key: string,
  values: string[],
  normalize: (value: string) => string = (value) => value,
): StringSetMap {
  const existing = map[key] ?? [];
  const merged = [...existing];
  let changed = false;
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized && !merged.includes(normalized)) {
      merged.push(normalized);
      changed = true;
    }
  }
  return changed ? { ...map, [key]: merged } : map;
}
