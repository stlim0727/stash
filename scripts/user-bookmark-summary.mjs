#!/usr/bin/env node

/**
 * Live Supabase User & Device Bookmark Summary
 *
 * Inspects auth.users, user_sync_status, anon_user_cleanup_log, and public.bookmarks
 * from the live Supabase project. Provides both a per-user status summary and
 * an install-base / session audit (separating automated test bursts from organic accounts).
 *
 * Usage:
 *   node scripts/user-bookmark-summary.mjs [--devices] [--json]
 *   pnpm summary:users [--devices] [--json]
 *
 * Credentials resolved in order:
 *   1. SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in environment
 *   2. .env.local or .env in current working directory
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SUPABASE_URL = 'https://stzutoejnhzxzhjsjtsi.supabase.co';
const DEFAULT_TIMEOUT_MS = 15000;

function readDotEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const env = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadConfig() {
  const localEnv = readDotEnv(path.join(process.cwd(), '.env.local'));
  const rootEnv = readDotEnv(path.join(process.cwd(), '.env'));

  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    localEnv.EXPO_PUBLIC_SUPABASE_URL ||
    rootEnv.EXPO_PUBLIC_SUPABASE_URL ||
    DEFAULT_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    localEnv.SUPABASE_SECRET_KEY ||
    localEnv.SUPABASE_SERVICE_ROLE_KEY ||
    rootEnv.SUPABASE_SECRET_KEY ||
    rootEnv.SUPABASE_SERVICE_ROLE_KEY;

  return { url: url.replace(/\/$/, ''), key };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAuthUsers(url, key) {
  let allUsers = [];
  let page = 1;
  while (true) {
    const res = await fetchWithTimeout(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch auth users (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!data.users || data.users.length === 0) break;
    allUsers = allUsers.concat(data.users);
    if (data.users.length < 100) break;
    page++;
  }
  return allUsers;
}

async function fetchAllRestPages(url, key, endpoint, pageSize = 1000) {
  let allRows = [];
  let from = 0;
  const separator = endpoint.includes('?') ? '&' : '?';
  while (true) {
    const to = from + pageSize - 1;
    const res = await fetchWithTimeout(`${url}/rest/v1/${endpoint}${separator}limit=${pageSize}&offset=${from}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /rest/v1/${endpoint} failed (${res.status}): ${text}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}

function safeString(val) {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : null;
}

function getLatestTimestamp(timestamps) {
  let latest = null;
  let maxEpoch = -Infinity;
  for (const ts of timestamps) {
    if (typeof ts === 'string' && ts.trim().length > 0) {
      const epoch = new Date(ts).getTime();
      if (!Number.isNaN(epoch) && epoch > maxEpoch) {
        maxEpoch = epoch;
        latest = ts;
      }
    }
  }
  return latest;
}

function daysAgo(dateStr, now) {
  if (!dateStr) return 9999;
  return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

function detectBursts(users) {
  // Only cluster anonymous Android users with 0 bookmarks and an app_version
  const candidates = users.filter(
    (u) =>
      u.is_anonymous &&
      u.platform === 'android' &&
      u.bookmarks === 0 &&
      u.archived === 0 &&
      Boolean(u.app_version),
  );

  const byVersion = new Map();
  for (const u of candidates) {
    if (!byVersion.has(u.app_version)) byVersion.set(u.app_version, []);
    byVersion.get(u.app_version).push(u);
  }

  const burstIds = new Set();
  const BURST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const MIN_BURST_COUNT = 5;

  for (const cohort of byVersion.values()) {
    cohort.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (let i = 0; i < cohort.length; i++) {
      const t0 = new Date(cohort[i].created_at).getTime();
      const cluster = [cohort[i]];
      for (let j = i + 1; j < cohort.length; j++) {
        const t1 = new Date(cohort[j].created_at).getTime();
        if (t1 - t0 <= BURST_WINDOW_MS) {
          cluster.push(cohort[j]);
        } else {
          break;
        }
      }
      if (cluster.length >= MIN_BURST_COUNT) {
        for (const b of cluster) burstIds.add(b.id);
      }
    }
  }
  return burstIds;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const devicesOnly = args.includes('--devices');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Live Supabase User & Device Bookmark Summary

Usage:
  pnpm summary:users [--devices] [--json]
  node scripts/user-bookmark-summary.mjs [--devices] [--json]

Options:
  --devices   Focus on install-base / session audit (organic vs automated test bursts)
  --json      Output aggregated raw JSON data
  --help, -h  Show this help message
`);
    process.exit(0);
  }

  const { url, key } = loadConfig();
  if (!key) {
    console.error(
      'Error: SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required.\nSet it in environment or .env / .env.local.',
    );
    process.exit(1);
  }

  // 1. Fetch all datasets concurrently with bounded timeouts & pagination
  const [authUsers, rSync, rCleanup, rBookmarks] = await Promise.all([
    fetchAuthUsers(url, key),
    fetchAllRestPages(url, key, 'user_sync_status'),
    fetchAllRestPages(url, key, 'anon_user_cleanup_log'),
    fetchAllRestPages(
      url,
      key,
      'bookmarks?select=id,user_id,collection_id,is_archived,deleted_at,metadata_status,last_saved_at&deleted_at=is.null',
    ),
  ]);

  let totalReaped = 0;
  if (Array.isArray(rCleanup)) {
    for (const log of rCleanup) {
      totalReaped += log.deleted_count || log.users_deleted || 0;
    }
  }

  // 2. Aggregate bookmark metrics per user
  // Invariant: active bookmarks must exclude both deleted_at != null and is_archived = true.
  const userBookmarkStats = new Map();
  let totalActiveBookmarks = 0;
  let totalArchivedBookmarks = 0;

  for (const b of rBookmarks) {
    const uid = b.user_id;
    if (!userBookmarkStats.has(uid)) {
      userBookmarkStats.set(uid, {
        active: 0,
        archived: 0,
        collections: new Set(),
        metaPending: 0,
        lastSaved: null,
      });
    }
    const stat = userBookmarkStats.get(uid);
    if (b.is_archived) {
      stat.archived++;
      totalArchivedBookmarks++;
    } else {
      stat.active++;
      totalActiveBookmarks++;
    }
    if (b.collection_id) {
      stat.collections.add(b.collection_id);
    }
    if (b.metadata_status === 'pending') {
      stat.metaPending++;
    }
    if (b.last_saved_at) {
      stat.lastSaved = getLatestTimestamp([stat.lastSaved, b.last_saved_at]);
    }
  }

  const syncMap = new Map();
  for (const s of rSync) syncMap.set(s.user_id, s);

  const now = new Date();

  // 3. Synthesize per-user records with safe metadata handling and max-timestamp activity
  const users = authUsers.map((u) => {
    const sync = syncMap.get(u.id);
    const bmStat = userBookmarkStats.get(u.id) || {
      active: 0,
      archived: 0,
      collections: new Set(),
      metaPending: 0,
      lastSaved: null,
    };
    const meta = typeof u.user_metadata === 'object' && u.user_metadata !== null ? u.user_metadata : {};
    const platform = safeString(meta.platform);
    const appVersion = safeString(meta.app_version) || safeString(sync?.app_version);
    const appVersionUpdatedAt = safeString(meta.app_version_updated_at);
    const versionSeen = appVersionUpdatedAt ? appVersionUpdatedAt.slice(0, 10) : null;

    const effectiveLastActive = getLatestTimestamp([
      sync?.last_synced_at,
      appVersionUpdatedAt,
      u.last_sign_in_at,
      u.created_at,
      bmStat.lastSaved,
    ]);

    return {
      id: u.id,
      email: safeString(u.email),
      is_anonymous: Boolean(u.is_anonymous),
      account_type: u.is_anonymous ? 'anonymous' : 'registered',
      platform,
      app_version: appVersion,
      version_seen: versionSeen,
      bookmarks: bmStat.active,
      archived: bmStat.archived,
      collections_used: bmStat.collections.size,
      meta_pending: bmStat.metaPending,
      last_saved: bmStat.lastSaved ? bmStat.lastSaved.slice(0, 10) : null,
      created_at: u.created_at,
      last_active: effectiveLastActive,
      days_inactive: daysAgo(effectiveLastActive, now),
      last_synced_at: safeString(sync?.last_synced_at),
    };
  });

  const burstIds = detectBursts(users);
  const burstCount = burstIds.size;

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          timestamp: now.toISOString(),
          total_users: users.length,
          total_reaped_anonymous: totalReaped,
          cumulative_lifetime_sessions: users.length + totalReaped,
          total_active_bookmarks: totalActiveBookmarks,
          total_archived_bookmarks: totalArchivedBookmarks,
          burst_detected_count: burstCount,
          users,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Formatting output
  const anonUsers = users.filter((u) => u.is_anonymous);
  const regUsers = users.filter((u) => !u.is_anonymous);
  const emptyAnon = anonUsers.filter((u) => u.bookmarks === 0 && u.archived === 0);
  const withVersion = users.filter((u) => u.app_version);

  console.log('\n========================================================================================');
  console.log('                        KEEPORY / STASH SUPABASE SUMMARY REPORT                         ');
  console.log('========================================================================================\n');

  console.log('--- HEADLINE TOTALS ---');
  console.log(`• Active Bookmarks:             ${totalActiveBookmarks} (plus ${totalArchivedBookmarks} archived)`);
  console.log(`• Current Retained Accounts:    ${users.length} (${regUsers.length} registered, ${anonUsers.length} anonymous)`);
  console.log(`• Empty Anonymous Accounts (0): ${emptyAnon.length}`);
  console.log(`• Version Stamp Coverage:       ${withVersion.length} / ${users.length} users (${Math.round((withVersion.length / users.length) * 100)}%)`);
  console.log(`• Historically Reaped (Cron):   ${totalReaped} empty/idle anonymous accounts`);
  console.log(`• Cumulative Lifetime Sessions: ${users.length + totalReaped} auth sessions ever created (retained + reaped)\n`);

  // Platform & Version breakdown
  const platforms = {};
  for (const u of users) {
    const p = u.platform || '(unspecified)';
    platforms[p] = (platforms[p] || 0) + 1;
  }

  console.log('--- PLATFORM BREAKDOWN (ACCOUNTS / SESSIONS) ---');
  for (const [p, count] of Object.entries(platforms)) {
    const pct = Math.round((count / users.length) * 100);
    console.log(`• ${p.padEnd(15)}: ${String(count).padStart(3)} sessions (${pct}%)`);
  }
  console.log();

  const androidUsers = users.filter((u) => u.platform === 'android');
  const webUsers = users.filter((u) => u.platform === 'web');
  const organicAndroid = androidUsers.filter((u) => !burstIds.has(u.id));

  console.log('--- INSTALL-BASE & SESSION AUDIT ---');
  console.log('  (Anonymous accounts are 1:1 per install session; registered accounts can span multiple devices)');
  console.log(`• Android Sessions / Installs:  ${androidUsers.length}`);
  if (burstCount > 0) {
    console.log(`  - Automated Test Bursts:      ${burstCount} accounts (Play Store Pre-Launch / Test Lab)`);
    console.log(`  - Organic Android Installs:   ${organicAndroid.length} accounts`);
  }
  console.log(`  - With >= 1 active bookmark:  ${organicAndroid.filter((u) => u.bookmarks > 0).length}`);
  console.log(`  - Active in last 24 hours:    ${organicAndroid.filter((u) => u.days_inactive <= 1).length}`);
  console.log(`  - Active in last 7 days:      ${organicAndroid.filter((u) => u.days_inactive <= 7).length}`);
  console.log(`  - Active in last 30 days:     ${organicAndroid.filter((u) => u.days_inactive <= 30).length}`);
  console.log(`  - Inactive > 30 days:         ${organicAndroid.filter((u) => u.days_inactive > 30).length}\n`);

  console.log(`• Web Sessions:                 ${webUsers.length} (${webUsers.filter((u) => u.bookmarks > 0).length} with active bookmarks, ${webUsers.filter((u) => u.days_inactive <= 7).length} active in 7d)\n`);

  const versions = {};
  for (const u of users) {
    const v = u.app_version || '(none yet)';
    versions[v] = (versions[v] || 0) + 1;
  }

  console.log('--- APP VERSION ADOPTION ---');
  for (const [v, count] of Object.entries(versions)) {
    console.log(`• ${v.padEnd(15)}: ${String(count).padStart(3)} accounts`);
  }
  console.log();

  if (!devicesOnly) {
    const regWithBookmarks = regUsers.filter((u) => u.bookmarks > 0 || u.archived > 0);
    const regZeroBookmarks = regUsers.filter((u) => u.bookmarks === 0 && u.archived === 0);
    const anonWithBookmarks = anonUsers.filter((u) => u.bookmarks > 0 || u.archived > 0);

    console.log('--- USERS WITH BOOKMARKS ---');
    console.log(
      'User                       | Type       | Active | Arch | Coll | Pending | Version    | Platform | Last Saved',
    );
    console.log(
      '---------------------------+------------+--------+------+------+---------+------------+----------+-----------',
    );

    // Render registered users with bookmarks first
    for (const r of regWithBookmarks) {
      const email = (r.email || '—').slice(0, 26).padEnd(26);
      const type = 'registered'.padEnd(10);
      const active = String(r.bookmarks).padStart(6);
      const arch = String(r.archived).padStart(4);
      const coll = String(r.collections_used).padStart(4);
      const pend = String(r.meta_pending).padStart(7);
      const ver = (r.app_version || '—').padEnd(10);
      const plat = (r.platform || '—').padEnd(8);
      const saved = r.last_saved || '—';
      console.log(`${email} | ${type} | ${active} | ${arch} | ${coll} | ${pend} | ${ver} | ${plat} | ${saved}`);
    }

    // Render anonymous users with bookmarks
    for (const a of anonWithBookmarks.slice(0, 20)) {
      const shortId = `(anon) ${a.id.slice(0, 8)}`.padEnd(26);
      const type = 'anonymous '.padEnd(10);
      const active = String(a.bookmarks).padStart(6);
      const arch = String(a.archived).padStart(4);
      const coll = String(a.collections_used).padStart(4);
      const pend = String(a.meta_pending).padStart(7);
      const ver = (a.app_version || '—').padEnd(10);
      const plat = (a.platform || '—').padEnd(8);
      const saved = a.last_saved || '—';
      console.log(`${shortId} | ${type} | ${active} | ${arch} | ${coll} | ${pend} | ${ver} | ${plat} | ${saved}`);
    }

    if (anonWithBookmarks.length > 20) {
      console.log(`... and ${anonWithBookmarks.length - 20} more anonymous accounts with bookmarks.`);
    }

    if (regZeroBookmarks.length > 0) {
      console.log(`\n(Note: ${regZeroBookmarks.length} registered account(s) with 0 bookmarks omitted from detail table)`);
    }
    console.log();
  }

  console.log('========================================================================================\n');
}

main().catch((err) => {
  console.error('Execution error:', err);
  process.exit(1);
});
