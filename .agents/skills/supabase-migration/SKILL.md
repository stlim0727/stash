---
name: supabase-migration
description: >-
  Author and apply a Supabase migration for Stash the safe way — owner-scoped
  RLS, additive/backward-compatible DDL, and the deploy-ordering rule that has
  bitten this repo twice. Use whenever the user asks to "add a table/column",
  "write a migration", "change the schema", "add an RLS policy", "add an index /
  unique constraint", or when an edge-function change needs a schema
  prerequisite. Produces a migration that matches supabase/migrations conventions
  and won't 400 the live API on rollout.
---

# Write a Supabase migration (RLS-correct, deploy-safe)

Schema changes for Stash live in `supabase/migrations/*.sql` and run against the
live project (there is no local stack in this sandbox). The two things that go
wrong here are **RLS holes** (a table readable across users) and **deploy
ordering** (code shipped before its migration → the live API 400s). This skill
locks both down. The data model of record is `docs/architecture/data-model.md`;
RLS/backend ownership sits with the **backend-security-engineer** persona.

## Step 0 — Look before you write

- `mcp__Supabase__list_tables` to see the current structure; `list_migrations`
  to see what's already applied. Do **not** assume the live DB matches the files
  — migrations have fallen through the cracks before (see the ordering trap).
- Read the newest one or two files in `supabase/migrations/` to match style.

## Step 1 — Name and shape the file

- **Filename:** `YYYYMMDDHHMMSS_snake_case_description.sql`, timestamp-prefixed so
  it sorts after every existing migration. Pick a timestamp strictly greater than
  the last file in `supabase/migrations/`.
- **Make it backward-compatible / additive.** Existing installs and older app
  builds hit the same DB:
  - New table → `create table if not exists public.<name> (…)`.
  - New column → `alter table public.<t> add column if not exists <col> <type>`
    **nullable or with a default** (never `not null` without a default on a
    populated table). Client mappers must tolerate the column being absent on old
    rows (`api/bookmarks.ts` maps defensively — mirror that).
  - Every user-owned table gets `user_id uuid not null references auth.users(id)
    on delete cascade`.

## Step 2 — RLS is not optional

Every table with user data must:

```sql
alter table public.<t> enable row level security;
```

…and then carry a policy for **each operation the API actually exposes** — no
more. For a real CRUD table that's all four owner-scoped policies (the pattern
throughout `20260611000000_initial_schema.sql`); do **not** grant `update`/
`delete` the product doesn't offer:

```sql
create policy "Users can read their <t>"   on public.<t> for select
  using (auth.uid() = user_id);
create policy "Users can insert their <t>" on public.<t> for insert
  with check (auth.uid() = user_id);
create policy "Users can update their <t>" on public.<t> for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their <t>" on public.<t> for delete
  using (auth.uid() = user_id);
```

- **Append-only / support / ledger tables** get only the operations they expose:
  e.g. `feedback_reports` enables RLS with just owner `select` + `insert` (no
  update/delete). Some tables intentionally enable RLS with **no client policies
  at all** — the rate-limit / audit tables are reached only through
  `SECURITY DEFINER` functions, so a client has no direct access. Match the
  table's real access shape; the four-policy template is for genuine CRUD tables.
- **Join/child tables** (no direct `user_id`, e.g. `bookmark_tags`) scope through
  the parent with `using (exists (select 1 from public.<parent> p where p.id =
  <t>.<parent>_id and p.user_id = auth.uid()))` and the matching `with check` —
  see the `bookmark_tags` / `ai_enrichments` policies in the initial schema.
- **`SECURITY DEFINER` functions** (rate-limit slot, server-side triggers) must
  scope work to the owner explicitly by `user_id` — they bypass RLS by design;
  the server-trigger variants take the owner id as an argument and are
  `service_role`-only. Constant-time-compare any shared secret header.

## Step 3 — The deploy-ordering rule (this has bitten twice)

**A migration that code depends on must be applied *with or before* the code
deploy — never after.** Documented failures in `AGENTS.md`:

- `client_id`: the insert body started sending `client_id`; PostgREST **rejects
  an unknown column** until the migration adds it → every create 400s.
- `ai_enrichments` unique constraint: an `on_conflict=bookmark_id` upsert
  **hard-depends** on its `UNIQUE(bookmark_id)` constraint; the function was
  deployed while the migration wasn't applied → every enrichment ran the model
  (burning Gemini quota) then 400'd at the save with `42P10`.

So when your change spans SQL + code:

1. If an **edge function** (`mcp__Supabase__deploy_edge_function`) or a client
   insert/upsert references the new column/constraint, **apply the migration
   first** (`mcp__Supabase__apply_migration`), then deploy the code.
2. An `on_conflict` upsert or a new NOT-NULL-in-payload column is the classic
   trap — call it out in the PR body.
3. Design the runtime side to **fail safe** where capture is involved: a missing
   config / trigger secret must be a no-op, never an error that aborts a bookmark
   write (capture is sacred).

## Step 4 — Apply and verify

- **Apply:** `mcp__Supabase__apply_migration` (goes straight to the remote
  project — there's no local stack). After applying, `list_migrations` /
  `get_advisors` to confirm it landed and flagged no new RLS/security advisory.
- **Pure logic** that ships alongside (matchers, planners, request-auth) has a
  Node test lane: `pnpm test:functions` (`supabase/functions/**/*.test.ts`).
  Add/extend a `.test.ts` for any non-trivial function logic.
- **End-to-end:** `pnpm verify:supabase` (16 checks: auth, CRUD, dedupe, tags,
  enrichment, **RLS list/read/write isolation**) — needs
  `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY` and anonymous
  sign-ins enabled. Run it when the change touches the API surface or RLS.

## Report

State: the migration filename + what it changes, that RLS is enabled with the
four owner-scoped policies (or why a table legitimately has none), the
deploy-ordering call-out if code depends on it (apply-before-deploy), and the
verification you ran (`test:functions` / `verify:supabase` / advisors).
