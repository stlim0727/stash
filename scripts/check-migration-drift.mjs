#!/usr/bin/env node
/**
 * Fails (exit 1) if any migration file in supabase/migrations/ hasn't been
 * applied to the live Supabase project yet.
 *
 * This exists because a migration can be merged to main and simply never
 * run against production — there is no CI/CD step that applies
 * supabase/migrations/* automatically, so it depends on someone remembering
 * to run it by hand. (This is exactly how the 20260712000000
 * realtime_broadcast_policies migration sat unapplied for weeks and caused
 * STASH-5V/5T/5W: Realtime never joined sync:private:* channels because the
 * RLS policies it granted never existed on the live database.)
 *
 * Matches by migration NAME (the slug after the numeric prefix), not by
 * version number. In this repo, applying a migration by hand (dashboard SQL
 * editor, or the Supabase MCP apply_migration tool) records it under a fresh
 * version stamped at apply time, not the original filename's timestamp — so
 * comparing by version number alone produces wall-to-wall false positives.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=<management-api-personal-access-token> \
 *   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   node scripts/check-migration-drift.mjs
 *
 * SUPABASE_ACCESS_TOKEN is a Supabase *account* personal access token
 * (Dashboard -> Account -> Access Tokens), NOT the project anon/service key.
 * It's only used read-only here, to list applied migrations via the
 * Management API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGEMENT_API = 'https://api.supabase.com/v1';
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations',
);

// Confirmed (2026-08-07, live query) to already be in effect on production —
// applied ad hoc directly against the database rather than through the
// tracked migration mechanism, so they'll never show up as "applied" no
// matter how long we wait. Verified each by querying the live catalog for
// the objects the migration creates before adding it here; re-verify before
// removing an entry, don't just delete on suspicion.
const KNOWN_UNTRACKED_BUT_LIVE = new Set([
  // Baseline schema, predates migration-history tracking entirely.
  'initial_schema',
  // Functions/trigger (dispatch_ai_enrichment, request_ai_enrichment_slot*,
  // trigger ai_enrich_dispatch) all exist live.
  'ai_enrich_server_trigger',
  // Function + trigger (notify_feedback_bridge, on_feedback_report_created)
  // both exist live.
  'feedback_bridge_webhook',
  // RLS already enabled + anon/authenticated grants already revoked on both
  // tidy_backup_totohero_* tables live.
  'secure_tidy_backup_totohero_tables',
]);

function projectRefFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec((url || '').trim());
  if (!match) {
    throw new Error(`EXPO_PUBLIC_SUPABASE_URL is not a recognizable Supabase project URL: ${url}`);
  }
  return match[1];
}

function localMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^\d+_(.+)\.sql$/.exec(name);
      if (!match) throw new Error(`Migration file has no numeric version prefix: ${name}`);
      return { name, slug: match[1] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function appliedMigrationNames(token, ref) {
  const response = await fetch(`${MANAGEMENT_API}/projects/${ref}/database/migrations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Management API request failed: ${response.status} ${response.statusText} — ${await response.text()}`,
    );
  }
  const body = await response.json();
  return new Set(body.map((row) => row.name));
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;

  if (!token || !url) {
    console.log(
      'SUPABASE_ACCESS_TOKEN or EXPO_PUBLIC_SUPABASE_URL not set — skipping migration drift check.',
    );
    return;
  }

  const ref = projectRefFromUrl(url);
  const local = localMigrations();
  const applied = await appliedMigrationNames(token, ref);

  const pending = local.filter(
    (migration) => !applied.has(migration.slug) && !KNOWN_UNTRACKED_BUT_LIVE.has(migration.slug),
  );

  if (pending.length === 0) {
    console.log(`No unapplied migrations found on project ${ref}.`);
    return;
  }

  console.error(`${pending.length} migration(s) in supabase/migrations/ are NOT applied to project ${ref}:\n`);
  for (const migration of pending) {
    console.error(`  - ${migration.name}`);
  }
  console.error(
    '\nApply them (e.g. via the Supabase MCP apply_migration tool, `supabase db push`, or the ' +
      "SQL editor). If one is actually already in effect (applied ad hoc outside the tracked " +
      'migration mechanism), verify that live and add its slug to KNOWN_UNTRACKED_BUT_LIVE in ' +
      'this script — do not add an entry without confirming against the live database first.',
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
