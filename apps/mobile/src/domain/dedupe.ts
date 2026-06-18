import { canonicalizeUrl } from '@/domain/urls';

/**
 * The subset of a bookmark row the de-dup planner needs. Mirrors the cloud
 * `bookmarks` columns so the ops script can pass rows straight from PostgREST.
 */
export interface DedupeRow {
  id: string;
  user_id: string;
  url: string | null;
  url_hash: string | null;
  is_archived: boolean;
  created_at: string;
}

/** One set of active rows that canonicalize to the same URL for one user. */
export interface DedupeGroup {
  user_id: string;
  /** The canonical URL the group collapses to. */
  canonical: string;
  /** The surviving row: the earliest-created one (the original save). */
  keeperId: string;
  /** The redundant rows to fold into the keeper and delete, oldest first. */
  duplicateIds: string[];
}

/** A surviving row whose stored `url_hash` doesn't match its canonical URL. */
export interface HashRewrite {
  id: string;
  url_hash: string;
}

export interface DedupePlan {
  /** Active duplicate groups (each has 2+ rows); empty when nothing to merge. */
  groups: DedupeGroup[];
  /**
   * Rows that survive the merge but whose `url_hash` is stale (e.g. stored as
   * the raw normalized URL before canonicalization, or null). Rewriting these
   * keeps the cloud key consistent with the client + the active-URL unique
   * index, so future saves dedupe correctly.
   */
  hashRewrites: HashRewrite[];
}

/** Earliest `created_at` wins; ties break on the smallest id for determinism. */
function pickKeeper(rows: DedupeRow[]): DedupeRow {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at.localeCompare(b.created_at);
    }
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Plans how to collapse duplicate cloud bookmarks. Only **active** rows with a
 * URL are grouped (the server's unique index is active-only, and archived
 * twins are intentionally left alone). Within each `user_id` + canonical-URL
 * group of 2+ rows, the earliest row is kept and the rest are marked for
 * deletion. Separately, every surviving row whose `url_hash` differs from its
 * canonical URL is listed for a hash rewrite.
 *
 * Pure and deterministic: the same rows always yield the same plan, so it can
 * be reviewed as a dry run before anything is mutated.
 */
export function planBookmarkDeduplication(rows: DedupeRow[]): DedupePlan {
  const groups: DedupeGroup[] = [];
  const deleted = new Set<string>();

  const byKey = new Map<string, DedupeRow[]>();
  for (const row of rows) {
    if (!row.url || row.is_archived) {
      continue;
    }
    const key = `${row.user_id}\n${canonicalizeUrl(row.url)}`;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }

  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) {
      continue;
    }
    const keeper = pickKeeper(bucket);
    const duplicateIds = bucket
      .filter((row) => row.id !== keeper.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((row) => row.id);
    for (const id of duplicateIds) {
      deleted.add(id);
    }
    groups.push({
      user_id: keeper.user_id,
      canonical: key.slice(key.indexOf('\n') + 1),
      keeperId: keeper.id,
      duplicateIds,
    });
  }

  const hashRewrites: HashRewrite[] = [];
  for (const row of rows) {
    if (deleted.has(row.id) || !row.url) {
      continue;
    }
    const canonical = canonicalizeUrl(row.url);
    if (row.url_hash !== canonical) {
      hashRewrites.push({ id: row.id, url_hash: canonical });
    }
  }

  return { groups, hashRewrites };
}
