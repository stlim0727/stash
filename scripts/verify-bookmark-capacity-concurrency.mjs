// Isolated PostgreSQL 17 test. No production URL, credentials, or app deps.
// node scripts/verify-bookmark-capacity-concurrency.mjs <native-dir> <pg-module>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [nativeDir, pgModule] = process.argv.slice(2);
if (!nativeDir || !pgModule) throw new Error('Pass isolated PostgreSQL native directory and pg module path.');
const { default: pg } = await import(pathToFileURL(pgModule).href);
const run = promisify(execFile);
const directory = await mkdtemp('/tmp/keepory-capacity-pg-');
const env = { ...process.env, LD_LIBRARY_PATH: join(nativeDir, 'lib') };
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const options = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres' };
const clients = [];
let started = false;
async function connect() {
  const client = new pg.Client(options);
  await client.connect();
  clients.push(client);
  return client;
}
const sql = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ids = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`);
try {
  await run(join(nativeDir, 'bin/initdb'), ['-D', directory, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8'], { env });
  await run(join(nativeDir, 'bin/pg_ctl'), ['-D', directory, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory} -F`, '-w', 'start'], { env });
  started = true;
  const admin = await connect();
  await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, is_anonymous boolean);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to public;`);
  await admin.query((await sql('supabase/migrations/20260611000000_initial_schema.sql')).replace('create extension if not exists pgcrypto;', ''));
  await admin.query('grant all on all tables in schema public to authenticated;');
  await admin.query(await sql('supabase/migrations/20261005113906_bookmark_capacity_limits.sql'));
  await admin.query('insert into auth.users select unnest($1::uuid[]),false', [ids]);
  await admin.query('update public.bookmark_capacity_limits set enabled=true, anonymous_limit=1, registered_limit=1, project_limit=100');
  const workers = await Promise.all(ids.map(() => connect()));
  async function insert(client, user) {
    await client.query('begin');
    try {
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      await client.query('set local role authenticated');
      await client.query("insert into public.bookmarks(user_id,title) values ($1,'concurrent fixture')", [user]);
      await client.query('commit');
      return 'allowed';
    } catch (error) {
      await client.query('rollback');
      if (error.code !== 'PT429') throw error;
      return 'denied';
    }
  }
  let results = await Promise.all(workers.map((client) => insert(client, ids[0])));
  assert.equal(results.filter((r) => r === 'allowed').length, 1);
  assert.equal(Number((await admin.query('select bookmark_count from public.bookmark_capacity_limits')).rows[0].bookmark_count), 1);
  console.log('PASS: 20 independent connections at account cap 1 admit exactly one write.');
  await admin.query('delete from public.bookmarks');
  await admin.query('update public.bookmark_capacity_limits set project_limit=1');
  results = await Promise.all(workers.map((client, i) => insert(client, ids[i])));
  assert.equal(results.filter((r) => r === 'allowed').length, 1);
  assert.equal(Number((await admin.query('select count(*) from public.bookmarks')).rows[0].count), 1);
  console.log('PASS: 20 accounts racing for project cap 1 admit exactly one write.');
  await admin.query('delete from public.bookmarks');
  await workers[0].query('begin');
  await workers[0].query('insert into public.bookmarks(user_id,title) values ($1,$2)', [ids[0], 'rollback fixture']);
  let settled = false;
  const blocked = insert(workers[1], ids[1]).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'second admission must await first transaction');
  await workers[0].query('rollback');
  assert.equal(await blocked, 'allowed');
  const ledger = (await admin.query(`select
    (select count(*) from public.bookmarks) as rows,
    (select sum(bookmark_count) from public.bookmark_capacity_usage) as users,
    (select bookmark_count from public.bookmark_capacity_limits) as project`)).rows[0];
  assert.deepEqual(Object.values(ledger).map(Number), [1, 1, 1]);
  console.log('PASS: rollback releases capacity; waiting request and all usage counters agree.');
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  if (started) await run(join(nativeDir, 'bin/pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { env });
  await rm(directory, { recursive: true, force: true });
}
