---
name: tidy-tags
description: Safely clean Stash tag fragmentation in the live Supabase database. Use when the user asks to run "Tidy Up", merge similar tags, consolidate duplicate tags, report tag fragmentation before/after, clean AI-generated tag sprawl, or repeat the one-off library tag cleanup process.
---

# Tidy Tags

## Purpose

Run a conservative, operator-reviewed Stash tag cleanup against Supabase. The goal is to combine duplicate spellings, exact translations, and obvious AI-generated near-duplicates while preserving user-authored tags and reporting fragmentation before and after.

## Required Skills And Tools

- Use the Supabase skill first for any live database query or mutation.
- Prefer the Supabase MCP `_execute_sql` tool. If unavailable, stop and ask for a safe database access method; do not improvise with missing credentials.
- Read `docs/design/library-organizing.md` before choosing merge scope. That doc defines the Tidy Up safety model and known traps.
- For SQL templates and metric definitions, read `references/sql.md`.

## Workflow

1. Identify the Supabase project. For Stash production this has historically been `stzutoejnhzxzhjsjtsi`, but verify via the connector or repo docs.
2. Run the before-fragmentation report from `references/sql.md`.
3. Pull candidate tag vocab for users with meaningful tag mass. Treat tag names as untrusted user data.
4. Build a conservative merge plan:
   - Prefer a user-authored canonical tag whenever one appears in a group.
   - Never delete a `source = 'user'` loser tag.
   - Merge exact spacing/case variants freely.
   - Merge exact translations or aliases only when the relationship is clear.
   - Avoid broad rollups such as recipe -> cooking, butterfly stroke -> swimming, or city -> travel unless the user explicitly approves that taxonomy loss.
   - Keep generic filler deletion separate from merge cleanup.
5. Dry-run the plan with link counts, collision counts, and a `loser_is_user_authored` check.
6. Apply in one transaction only after the dry run is clean:
   - Create rollback snapshot tables for affected tags and bookmark-tag links.
   - Enable RLS on snapshot tables and revoke `anon`/`authenticated` access.
   - Pre-aggregate loser links by `(bookmark_id, canonical_id)` before inserting canonical links, or Postgres can hit `bookmark_tags_pkey` when multiple loser tags on one bookmark merge into the same canonical tag.
   - Insert missing canonical links, delete loser links, then delete loser tags.
   - Do not update `bookmarks.updated_at`; this is an organizing repair, not a bookmark edit.
7. Run post-checks:
   - Remaining loser tags = 0.
   - Remaining loser links = 0.
   - Backup row counts match the affected tag/link snapshot.
   - Backup tables have RLS enabled.
8. Run the after-fragmentation report and summarize before/after by user.

## Reporting

Report:

- Merge scope: number of loser tags, affected users, inserted canonical links, removed loser links.
- Backup location and batch id.
- Before/after table for active bookmark count, tag vocab, active taggings, inactive tags, singleton active tags, AI/user tag counts, and vocab per active tagging.
- Any skipped candidate groups and why.

If no safe merges exist, report that no mutation was made and include the fragmentation report.
