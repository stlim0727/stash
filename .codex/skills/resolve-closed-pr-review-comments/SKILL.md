---
name: resolve-closed-pr-review-comments
description: >-
  Identify and address unresolved review comments on recently closed PRs for Stash.
  Use when asked to "address review comments from closed PRs", "find unresolved reviews",
  "reply and resolve comments", or follow up on merged/closed PR discussions.
---

# Resolve Closed PR Review Comments

When PRs merge or close, some review comment threads might remain unresolved. This skill provides the procedure to find, address, reply to, and resolve these threads on GitHub.

## Procedure

### Step 1 — Find Unresolved Comments
Run the helper script to scan PRs closed/merged in the last 24 hours:

```bash
node .claude/skills/resolve-closed-pr-review-comments/scripts/fetch-unresolved-comments.mjs
```

This script will query the GitHub GraphQL API to find:
- PRs closed within the last 24 hours.
- Any review thread that has `isResolved: false`.
- The GraphQL `threadId`, REST comment `id`, comment author, path, line, and body.

### Step 2 — Fix and Commit
1. Switch to a new branch for the fixes:
   ```bash
   git checkout -b agent/resolve-closed-pr-review-comments
   ```
2. Implement fixes for each unresolved comment.
3. Validate changes locally:
   * Run format: `npx pnpm format` (discard changes on untouched files so the diff is clean)
   * Run typecheck: `npx pnpm typecheck`
   * Run tests: `npx pnpm test`
4. Commit the changes and push the branch.

### Step 3 — Open a Follow-Up PR
Open a new pull request containing the fixes. In the PR body:
- List each addressed PR number and comment thread description.
- Identify the author as Antigravity by adding the `(Antigravity-authored)` label at the end.

### Step 4 — Reply and Resolve on GitHub
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
