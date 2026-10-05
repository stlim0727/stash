// Offline PostgreSQL/RLS verification using an externally installed PGlite.
// Usage: node scripts/verify-public-launch-sql.mjs /path/to/pglite/dist/index.js
// No production connection or credentials are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the local PGlite module path.');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, aud text, role text, is_anonymous boolean);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to public;
  `);
  await db.exec((await sql('supabase/migrations/20260611000000_initial_schema.sql'))
    .replace('create extension if not exists pgcrypto;', ''));
  await db.exec(await sql('supabase/migrations/20260622075624_api_keys.sql'));
  const queueSql = await sql('supabase/migrations/20260723150000_pending_ai_enrichment_queue.sql');
  await db.exec(queueSql.slice(0, queueSql.indexOf('-- ── Scheduled dispatch')));
  await db.exec('grant all on all tables in schema public to anon, authenticated, service_role;');

  // Confirm the original direct-key vulnerability exists in the test baseline.
  await db.exec(`
    begin;
    insert into auth.users values ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', true);
    select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    set local role authenticated;
    insert into public.api_keys(user_id, name, key_hash) values
      ('00000000-0000-4000-8000-000000000001', 'forged key baseline', 'test-hash');
    rollback;
  `);
  console.log('Baseline: an authenticated caller can insert its own API key directly.');

  await db.exec(await sql('supabase/migrations/20261005070404_public_launch_access_hardening.sql'));
  await db.exec(await sql('supabase/migrations/20261005070406_ai_global_budget.sql'));
  await db.exec(await sql('supabase/tests/public-launch-hardening.sql'));
  console.log('PASS: direct key CRUD/read denied, own enrichment update preserved, foreign reassignment denied, internal RPCs denied, global cap and kill switch enforced.');
  assert.equal((await db.query('select count(*)::int as count from auth.users')).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::int as count from public.ai_budget_reservations')).rows[0].count, 0);

  await db.exec(`
    begin;
    insert into auth.users(id, aud, role, is_anonymous) values
      ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', true);
    insert into public.bookmarks(user_id, title, content_type)
      select '00000000-0000-4000-8000-000000000001', 'queue fixture', 'text' from generate_series(1,42);
    insert into public.pending_ai_enrichment(bookmark_id, user_id)
      select id, user_id from public.bookmarks;
    set local role service_role;
  `);
  const claim = () => db.query('select count(*)::int as count from public.claim_pending_ai_enrichment_batch(100000)');
  assert.equal((await claim()).rows[0].count, 40);
  assert.equal((await claim()).rows[0].count, 2);
  assert.equal((await claim()).rows[0].count, 0);
  await db.exec('rollback;');
  console.log('PASS: queue claim is bounded to 40 and does not reclaim active leases. This single-connection test does not prove concurrent-worker behavior.');

  await db.exec(`
    begin;
    update public.ai_runtime_limits set hourly_call_limit=10, daily_call_limit=2;
    set local role service_role;
    select public.reserve_ai_enrichment_budget();
    select public.reserve_ai_enrichment_budget();
  `);
  assert.equal((await db.query('select public.reserve_ai_enrichment_budget() as verdict')).rows[0].verdict.allowed, false);
  await db.exec('reset role; delete from public.ai_runtime_limits; set local role service_role;');
  assert.equal((await db.query('select public.reserve_ai_enrichment_budget() as verdict')).rows[0].verdict.allowed, false);
  await db.exec('rollback;');
  console.log('PASS: daily cap, missing configuration and rollback cleanup.');

  // Model the Storage metadata schema and owner-policy helper; this verifies
  // SQL policy/configuration only, not the deployed HTTP/CDN behavior.
  await db.exec(`
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
    grant usage on schema storage to authenticated, anon, service_role;
    grant select, insert, update, delete on storage.objects to authenticated, anon, service_role;
  `);
  await db.exec(await sql('supabase/migrations/20260819071500_bookmark_images_storage_bucket.sql'));
  await db.exec(await sql('supabase/deferred-migrations/private_bookmark_images.sql'));
  const bucket = (await db.query("select public, allowed_mime_types from storage.buckets where id='bookmark-images'")).rows[0];
  assert.equal(bucket.public, false);
  assert.ok(!bucket.allowed_mime_types.includes('image/svg+xml'));
  await db.exec(`
    begin;
    insert into storage.objects(bucket_id, name) values ('bookmark-images', 'a/image'), ('bookmark-images', 'b/image');
    -- Real object paths use UUIDs; the auth.uid() policy requires a UUID here.
    update storage.objects set name='00000000-0000-4000-8000-000000000001/image' where name='a/image';
    select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    set local role authenticated;
  `);
  assert.equal((await db.query('select count(*)::int as count from storage.objects')).rows[0].count, 1);
  await db.exec("reset role; select set_config('request.jwt.claim.sub', '', true); set local role anon;");
  assert.equal((await db.query('select count(*)::int as count from storage.objects')).rows[0].count, 0);
  await db.exec('rollback;');
  console.log('PASS: private bucket configuration, SVG upload exclusion, owner-only Storage SELECT. HTTP access and CDN cache invalidation still require deployment smoke tests.');
} finally {
  await db.close();
}
