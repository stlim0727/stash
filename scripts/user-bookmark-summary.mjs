#!/usr/bin/env node

/**
 * Live Supabase User & Device Bookmark Summary
 *
 * Inspects auth.users, admin_user_overview, user_sync_status, and
 * anon_user_cleanup_log from the live Supabase project. Provides both a per-user
 * status summary and an install-base / device audit (separating automated test
 * bursts from organic installs).
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

async function fetchAuthUsers(url, key) {
  let allUsers = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch auth users: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (!data.users || data.users.length === 0) break;
    allUsers = allUsers.concat(data.users);
    if (data.users.length < 100) break;
    page++;
  }
  return allUsers;
}

async function fetchRest(url, key, endpoint, extraHeaders = {}) {
  const res = await fetch(`${url}/rest/v1/${endpoint}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /rest/v1/${endpoint} failed (${res.status}): ${text}`);
  }
  return res;
}

function daysAgo(dateStr, now) {
  if (!dateStr) return 9999;
  return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

function detectBursts(users) {
  // Sort by created_at
  const sorted = [...users].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const burstIds = new Set();
  const BURST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const MIN_BURST_COUNT = 5;

  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i];
    if (u.bookmarks > 0 || !u.is_anonymous) continue;
    const t0 = new Date(u.created_at).getTime();
    const cluster = [u];

    for (let j = i + 1; j < sorted.length; j++) {
      const u2 = sorted[j];
      if (u2.bookmarks > 0 || !u2.is_anonymous) continue;
      const t1 = new Date(u2.created_at).getTime();
      if (t1 - t0 <= BURST_WINDOW_MS) {
        cluster.push(u2);
      } else {
        break;
      }
    }

    if (cluster.length >= MIN_BURST_COUNT) {
      for (const b of cluster) burstIds.add(b.id);
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
  --devices   Focus on install-base / device audit (organic vs automated test bursts)
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

  // 1. Fetch all datasets concurrently
  const [authUsers, rOverview, rSync, rCleanup, rBookmarksCount] = await Promise.all([
    fetchAuthUsers(url, key),
    fetchRest(url, key, 'admin_user_overview?select=*').then((r) => r.json()),
    fetchRest(url, key, 'user_sync_status?select=*').then((r) => r.json()),
    fetchRest(url, key, 'anon_user_cleanup_log?select=*').then((r) => r.json()),
    fetchRest(url, key, 'bookmarks?select=count', {
      Prefer: 'count=exact',
      Range: '0-0',
    }),
  ]);

  const totalBookmarks =
    rBookmarksCount.headers.get('content-range')?.split('/')[1] || 'unknown';

  let totalReaped = 0;
  if (Array.isArray(rCleanup)) {
    for (const log of rCleanup) {
      totalReaped += log.deleted_count || log.users_deleted || 0;
    }
  }

  const syncMap = new Map();
  for (const s of rSync) syncMap.set(s.user_id, s);

  const overviewMap = new Map();
  for (const o of rOverview) overviewMap.set(o.user_id, o);

  const now = new Date();

  // 2. Synthesize per-user record
  const users = authUsers.map((u) => {
    const sync = syncMap.get(u.id);
    const ov = overviewMap.get(u.id);
    const meta = u.user_metadata || {};
    const platform = meta.platform || null;
    const appVersion = meta.app_version || sync?.app_version || null;
    const versionSeen = meta.app_version_updated_at ? meta.app_version_updated_at.slice(0, 10) : null;
    const effectiveLastActive =
      sync?.last_synced_at || meta.app_version_updated_at || u.last_sign_in_at || u.created_at;

    return {
      id: u.id,
      email: u.email || null,
      is_anonymous: u.is_anonymous,
      account_type: u.is_anonymous ? 'anonymous' : 'registered',
      platform,
      app_version: appVersion,
      version_seen: versionSeen,
      bookmarks: ov?.bookmark_count ?? 0,
      created_at: u.created_at,
      last_active: effectiveLastActive,
      days_inactive: daysAgo(effectiveLastActive, now),
      last_synced_at: sync?.last_synced_at || null,
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
          lifetime_installs: users.length + totalReaped,
          total_active_bookmarks: totalBookmarks,
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
  const emptyAnon = anonUsers.filter((u) => u.bookmarks === 0);
  const withVersion = users.filter((u) => u.app_version);

  console.log('\n========================================================');
  console.log('         KEEPORY / STASH SUPABASE SUMMARY REPORT        ');
  console.log('========================================================\n');

  console.log('--- HEADLINE TOTALS ---');
  console.log(`• Total Bookmarks (Active):     ${totalBookmarks}`);
  console.log(`• Current Retained Users:       ${users.length} (${regUsers.length} registered, ${anonUsers.length} anonymous)`);
  console.log(`• Empty Anonymous Accounts (0): ${emptyAnon.length}`);
  console.log(`• Version Stamp Coverage:       ${withVersion.length} / ${users.length} users (${Math.round((withVersion.length / users.length) * 100)}%)`);
  console.log(`• Historically Reaped (Cron):   ${totalReaped} empty/idle anonymous sessions`);
  console.log(`• Cumulative Lifetime Installs: ${users.length + totalReaped} installs ever connected\n`);

  // Platform & Version breakdown
  const platforms = {};
  for (const u of users) {
    const p = u.platform || '(unspecified)';
    platforms[p] = (platforms[p] || 0) + 1;
  }

  console.log('--- PLATFORM BREAKDOWN ---');
  for (const [p, count] of Object.entries(platforms)) {
    const pct = Math.round((count / users.length) * 100);
    console.log(`• ${p.padEnd(15)}: ${String(count).padStart(3)} users (${pct}%)`);
  }
  console.log();

  const androidUsers = users.filter((u) => u.platform === 'android');
  const webUsers = users.filter((u) => u.platform === 'web');
  const organicAndroid = androidUsers.filter((u) => !burstIds.has(u.id));

  console.log('--- INSTALL-BASE & DEVICE AUDIT ---');
  console.log(`• Android Total Devices:        ${androidUsers.length}`);
  if (burstCount > 0) {
    console.log(`  - Automated Test Bursts:      ${burstCount} devices (Play Store Pre-Launch / Test Lab)`);
    console.log(`  - Organic Android Installs:   ${organicAndroid.length} devices`);
  }
  console.log(`  - With >= 1 saved bookmark:   ${organicAndroid.filter((u) => u.bookmarks > 0).length}`);
  console.log(`  - Active in last 24 hours:    ${organicAndroid.filter((u) => u.days_inactive <= 1).length}`);
  console.log(`  - Active in last 7 days:      ${organicAndroid.filter((u) => u.days_inactive <= 7).length}`);
  console.log(`  - Active in last 30 days:     ${organicAndroid.filter((u) => u.days_inactive <= 30).length}`);
  console.log(`  - Inactive > 30 days:         ${organicAndroid.filter((u) => u.days_inactive > 30).length}\n`);

  console.log(`• Web Sessions:                 ${webUsers.length} (${webUsers.filter((u) => u.bookmarks > 0).length} with bookmarks, ${webUsers.filter((u) => u.days_inactive <= 7).length} active in 7d)\n`);

  const versions = {};
  for (const u of users) {
    const v = u.app_version || '(none yet)';
    versions[v] = (versions[v] || 0) + 1;
  }

  console.log('--- APP VERSION ADOPTION ---');
  for (const [v, count] of Object.entries(versions)) {
    console.log(`• ${v.padEnd(15)}: ${String(count).padStart(3)} users`);
  }
  console.log();

  if (!devicesOnly) {
    console.log('--- REGISTERED USERS ---');
    for (const r of regUsers) {
      const plat = r.platform || '—';
      const ver = r.app_version || '—';
      const date = r.last_active ? r.last_active.slice(0, 10) : '—';
      console.log(
        `• ${r.email?.padEnd(25)} | Platform: ${plat.padEnd(8)} | Version: ${ver.padEnd(10)} | Bookmarks: ${String(r.bookmarks).padStart(4)} | Last Active: ${date}`,
      );
    }
    console.log();

    const anonWithBookmarks = anonUsers.filter((u) => u.bookmarks > 0);
    console.log(`--- ANONYMOUS USERS WITH BOOKMARKS (${anonWithBookmarks.length} users) ---`);
    for (const a of anonWithBookmarks.slice(0, 15)) {
      const shortId = `anon-${a.id.slice(0, 8)}`;
      const plat = a.platform || '—';
      const ver = a.app_version || '—';
      const date = a.last_active ? a.last_active.slice(0, 10) : '—';
      console.log(
        `• ${shortId.padEnd(25)} | Platform: ${plat.padEnd(8)} | Version: ${ver.padEnd(10)} | Bookmarks: ${String(a.bookmarks).padStart(4)} | Last Active: ${date}`,
      );
    }
    if (anonWithBookmarks.length > 15) {
      console.log(`  ... and ${anonWithBookmarks.length - 15} more anonymous users with bookmarks.`);
    }
    console.log();
  }

  console.log('========================================================\n');
}

main().catch((err) => {
  console.error('Execution error:', err);
  process.exit(1);
});
