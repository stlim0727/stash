---
name: resolve-pr-review-comments
description: >-
  Identify and address unresolved review comments on open or recently closed PRs for Stash.
  Use when asked to "address review comments", "find unresolved reviews",
  "reply and resolve comments", or follow up on pull request feedback.
---

# Resolve PR Review Comments

When PRs are open or closed, review comment threads need to be addressed, replied to, and resolved. This skill provides the procedure to find, address, reply to, and resolve these threads on GitHub.

## Procedure

### Step 1 — Find Unresolved Comments
Run the helper script to scan open PRs or PRs closed in the last 24 hours:

```bash
# Scan all open PRs and recently closed PRs
node .claude/skills/resolve-pr-review-comments/scripts/fetch-unresolved-comments.mjs

# Scan unresolved comments on a specific PR (e.g. PR 489)
node .claude/skills/resolve-pr-review-comments/scripts/fetch-unresolved-comments.mjs 489
```

This script will query the GitHub GraphQL API to find:
- Unresolved review threads (`isResolved: false`).
- The GraphQL `threadId`, REST comment `id`, comment author, path, line, and body.

### Step 2 — Fix and Commit
1. Implement fixes for each unresolved comment.
2. Validate changes locally:
   * Run format: `npx pnpm format` (discard changes on untouched files so the diff is clean)
   * Run typecheck: `npx pnpm typecheck`
   * Run tests: `npx pnpm test`
3. Commit the changes and push.

### Step 3 — Post Reply and Resolve on GitHub
For each addressed thread:
1. **Post a reply**: Post a review comment reply referencing the fixing commit and clarifying the fix. Identify as Antigravity by adding `(Antigravity-authored)` to the body:
   ```bash
   gh api repos/stlim0727/stash/pulls/<pr_number>/comments \
     -F in_reply_to=<comment_id> \
     -F body="Addressed in <commit_sha>: <explanation> (Antigravity-authored)"
   ```
2. **Resolve the thread**: Mark the thread as resolved on GitHub using the GraphQL API:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: \"<thread_id>\" }) { thread { isResolved } } }'
   ```
