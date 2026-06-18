/**
 * One-off cloud cleanup: collapse duplicate bookmarks and canonicalize stored
 * `url_hash` values so they match the client + the active-URL unique index.
 *
 * Why: before the API canonicalized `url_hash`, the server deduped on the raw
 * normalized URL, so `…?utm_source=x` and the bare URL could become two active
 * cloud rows. This folds such duplicates into the earliest row (re-pointing its
 * tags and AI enrichments first, so nothing is orphaned) and rewrites every
 * surviving row's `url_hash` to the canonical form. Run it once alongside the
 * API change.
 *
 * Safe by default: prints a DRY RUN plan and changes nothing. Pass `--apply` to
 * execute. Optionally limit to one account with `--user=<uuid>`.
 *
 * Usage:
 *   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
 *   pnpm dedupe:supabase [--apply] [--user=<uuid>]
 *
 * The service-role key bypasses RLS so the script can see and merge rows across
 * all users; keep it out of client builds and shell history.
 */
import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);

const { planBookmarkDeduplication } = await import('../apps/mobile/src/domain/dedupe.ts');

const APPLY = process.argv.includes('--apply');
const userArg = process.argv.find((arg) => arg.startsWith('--user='));
const USER_FILTER = userArg ? userArg.slice('--user='.length) : null;

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing env. Set EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service-role key).',
  );
  process.exit(1);
}

const PAGE = 1000;

async function rest(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function userFilterParam() {
  return USER_FILTER ? `&user_id=eq.${USER_FILTER}` : '';
}

async function fetchAllBookmarks() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(
      `/rest/v1/bookmarks?select=id,user_id,url,url_hash,is_archived,created_at` +
        `&order=created_at.asc,id.asc&limit=${PAGE}&offset=${offset}${userFilterParam()}`,
    );
    rows.push(...page);
    if (page.length < PAGE) {
      return rows;
    }
  }
}

async function foldDuplicate(keeperId, dupId) {
  // Preserve the duplicate's tags on the keeper (merge-duplicates ignores links
  // the keeper already has), then re-point its AI enrichments, then delete it.
  const links = await rest(
    `/rest/v1/bookmark_tags?select=tag_id,source,confidence,created_at&bookmark_id=eq.${dupId}`,
  );
  if (links.length > 0) {
    await rest('/rest/v1/bookmark_tags', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: links.map((link) => ({ ...link, bookmark_id: keeperId })),
    });
  }
  await rest(`/rest/v1/ai_enrichments?bookmark_id=eq.${dupId}`, {
    method: 'PATCH',
    body: { bookmark_id: keeperId },
  });
  await rest(`/rest/v1/bookmarks?id=eq.${dupId}`, { method: 'DELETE' });
}

async function main() {
  console.log(
    `Stash bookmark de-dup — ${APPLY ? 'APPLY' : 'DRY RUN'}` +
      `${USER_FILTER ? ` (user ${USER_FILTER})` : ' (all users)'}\n`,
  );

  const bookmarks = await fetchAllBookmarks();
  console.log(`Fetched ${bookmarks.length} bookmark row(s).`);

  const plan = planBookmarkDeduplication(bookmarks);
  const dupCount = plan.groups.reduce((sum, group) => sum + group.duplicateIds.length, 0);
  console.log(
    `Plan: ${plan.groups.length} duplicate group(s) → remove ${dupCount} row(s); ` +
      `${plan.hashRewrites.length} url_hash rewrite(s).\n`,
  );

  for (const group of plan.groups) {
    console.log(
      `  • ${group.canonical}\n    keep ${group.keeperId}, ` +
        `remove ${group.duplicateIds.join(', ')}`,
    );
  }

  if (!APPLY) {
    console.log('\nDry run only — no changes made. Re-run with --apply to execute.');
    return;
  }

  console.log('\nApplying…');
  let removed = 0;
  for (const group of plan.groups) {
    for (const dupId of group.duplicateIds) {
      await foldDuplicate(group.keeperId, dupId);
      removed += 1;
    }
  }
  // Rewrite hashes after deletions so a keeper's new canonical hash can't
  // collide with a soon-to-be-removed duplicate on the active-URL unique index.
  let rewritten = 0;
  for (const { id, url_hash } of plan.hashRewrites) {
    await rest(`/rest/v1/bookmarks?id=eq.${id}`, { method: 'PATCH', body: { url_hash } });
    rewritten += 1;
  }

  console.log(`Done. Removed ${removed} duplicate(s); rewrote ${rewritten} url_hash value(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
