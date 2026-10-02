# Retrospective: Database Migration Deploy-Ordering and PR Merge Gate Failure

**Date:** 2026-10-02
**Incident:** PR #881 / Issue #882
**Impact:** Collection deletion and merge in the mobile app failed with `Could not find the function public.delete_user_collections(collection_ids, delete_action) in the schema cache` immediately after merging PR #881 to `main`.
**Resolution:** Migration applied to production Supabase by Codex via the Supabase connector (`20261002153439_collection_management_rpcs`).

---

## 1. What Happened

1. **New RPCs Introduced:** PR #881 implemented multi-selection, deletion, and merging of collections in Folder View. To prevent race conditions with concurrent bookmark creations or moves (which could be inadvertently uncategorized by `ON DELETE SET NULL`), migration `supabase/migrations/20261002140000_collection_management_rpcs.sql` introduced atomic PostgreSQL RPCs (`public.delete_user_collections` and `public.merge_user_collections`) with row locking (`FOR UPDATE`).
2. **Reviewer Feedback:** In review round 2, Codex correctly pointed out:
   > *"[P2] Remove the non-atomic fallback for destructive collection operations... Deploying the migration before enabling these controls avoids needing this unsafe fallback."*
3. **Mechanical Removal of Fallback:** Antigravity removed the 404 client-side fallback in commit `5177a69` to address the reviewer finding, but failed to ensure the prerequisite migration was actually live in production.
4. **Premature Merge Request:** Once CI checks passed and Codex approved the code, Antigravity asked the user to merge PR #881 without confirming that the database migration was live or alerting the user that the migration needed manual application first.
5. **Immediate Production Breakage:** Upon merging to `main`, Cloudflare Workers deployed automatically and the user ran the latest app code on device. Attempting to delete a collection triggered a 404 from PostgREST because the RPC function was not present in the live Supabase schema cache.
6. **Passive Escalation:** When the user provided a screenshot of the error, Antigravity dumped raw SQL instructions onto the user to execute manually in the Supabase Dashboard, rather than taking ownership of the deployment failure or properly diagnosing agent tooling capabilities. Codex subsequently stepped in and executed the migration directly via its Supabase connector.

---

## 2. Root Cause Analysis

### A. Violation of the Deploy-Ordering Invariant
`AGENTS.md` and `.claude/skills/supabase-migration/SKILL.md` document the foundational rule:
> *"A migration that code depends on must be applied with or before the code deploy — never after."*

In this project, migrations merged to `main` are **not** deployed automatically by CI/CD. Merging client code to `main` that unconditionally calls a new RPC without verifying the RPC is already deployed guarantees production failure.

### B. Blind Compliance with Code Review
Reviewers often propose idealized architecture assuming all stated prerequisites are in place. When Codex commented that deploying the migration eliminates the need for an unsafe fallback, the correct course of action was:
- Keep the fallback or gate the merge until the migration is confirmed live on production.
- Stripping the fallback while the migration was still unapplied turned a potential partial-failure edge case into a 100% deterministic failure for all users.

### C. Missing PR Merge Preflight Checklist
When asking the user to merge PR #881, Antigravity stated:
> *"All review feedback from Codex has been addressed and all CI checks have passed! Would you like me to merge PR #881 now?"*

The agent completely omitted the critical deployment dependency:
- The PR was **not** ready to merge because its database prerequisite had not been deployed.
- Presenting a PR as "ready" when it requires an out-of-band operational step misleads the user into merging breaking changes.

### D. Burden Shifting vs. Agent Autonomy
When a production failure occurred, the agent's first instinct was to shift the operational burden to the human user ("paste this 100-line SQL into the dashboard") rather than:
- Acknowledging the breach of deployment protocol.
- Checking environment tooling and credentials exhaustively.
- Explaining credential constraints transparently upfront.

---

## 3. Mandatory Invariants & Rules Going Forward

1. **Pre-Merge Migration Gate:**
   - Any PR containing a file in `supabase/migrations/` is **NEVER** "ready to merge" until the migration has been verified as applied to the target database.
   - When presenting PR status to the user, the database deployment status must be explicitly stated as the first line:
     - `[ ] Database migration applied to production? (YES / NO)`
   - If the migration cannot be applied automatically due to missing credentials, the agent must explicitly flag this blocker *before* proposing merge.

2. **Compatibility Fallback Removal Policy:**
   - When code review asks to remove a backward-compatibility fallback (such as a 404 handler for a new RPC or column), verify that the migration is **already deployed and verified live** before removing the fallback.

3. **Autonomous Execution First:**
   - When an unapplied migration or schema drift issue is discovered, agents must check and utilize available MCP connectors (`supabase`, `apply_migration`, `execute_sql`) before asking the user to perform manual dashboard actions.
   - If credentials prevent autonomous execution, clearly identify the exact missing credential (`SUPABASE_ACCESS_TOKEN`) and explain why rather than dumping raw manual work.
