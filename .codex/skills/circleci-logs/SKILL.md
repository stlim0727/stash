---
name: circleci-logs
description: >-
  Fetch the actual failing-step logs for a CircleCI build on Stash, when a PR's
  "ci/circleci: checks" status goes red. Use whenever you need to know WHY CI
  failed and the GitHub tools can't help — e.g. "why did CI fail on PR N",
  "grab the CircleCI logs", "get the CircleCI failure", "CircleCI is red",
  "diagnose the failing check", "what broke the ci workflow". Stash runs CI on
  CircleCI via the GitHub App, which reports as a legacy commit *status* (no
  GitHub check-run logs) — so the only way to read the failure is the CircleCI
  REST API. This skill knows the non-obvious slug/endpoint dance that actually
  returns raw step output for GitHub-App projects.
---

# Grab a CircleCI failure log

CI on Stash runs on **CircleCI** (`.circleci/config.yml`, workflow `ci`, single job `checks`). It's connected via the **GitHub App**, so:

- GitHub shows it as a **commit status** `ci/circleci: checks`, **not** a check-run → GitHub Actions log tools return nothing useful.
- The project uses the **App triplet slug** `circleci/{orgId}/{projId}` (not `gh/{org}/{repo}`), so classic v1.1 endpoints called with `gh/stlim0727/stash` answer **"Build not found."**
- There is **no documented v2 raw-log endpoint**, and this project does **not** store JUnit results (`/v2/.../tests` returns 0 items).

The working path (encoded in `fetch-failure.mjs`):

1. `GET /api/v2/workflow/{workflowId}/job` → find the `failed` job; read its `job_number` **and `project_slug`** (the triplet).
2. `GET /api/v1.1/project/{project_slug}/{job_number}` — v1.1 **does** work with the *triplet* slug; each `steps[].actions[]` has `failed`/`exit_code` and a presigned **`output_url`**.
3. `GET` that `output_url` → a JSON array of `{message}` chunks (sometimes gzipped) → strip ANSI → the real console log.

## Auth

Needs a CircleCI API token in **`CIRCLECI_TOKEN`** (already set in this environment). If missing, ask the user for a personal API token (CircleCI → User Settings → Personal API Tokens).

## Run it

Get the workflow id from the failing status' `target_url` (the webhook `Details` link, e.g. `https://app.circleci.com/workflow/<uuid>`), then:

```
node "%USERPROFILE%/.codex/skills/circleci-logs/fetch-failure.mjs" <workflow-id-or-url> [tailLines]
```

It accepts a bare workflow UUID **or** any CircleCI URL containing one, prints each failed job's failing step, the extracted failure markers (`FAIL`, `✕`, `Unable to find`, `expect(`, `Exit status`, …), and the tail of the log.

Don't have the workflow id? Get it from the PR's latest commit status:

```
# via GitHub commit status tools if exposed; otherwise open the PR status
# details URL in GitHub and copy the CircleCI workflow URL.
# statuses[].target_url has the workflow uuid.
```

## Then decide

- **Real regression** → reproduce locally (`pnpm lint` · `pnpm typecheck` · `pnpm test:components [file]` · `pnpm test`), fix, push.
- **Flake** (classic tell: a suite that runs ~4s locally shows **~30s+** on CI and only `waitFor`-based assertions time out, while the same commit is green locally) → re-run the workflow instead of "fixing" green tests:
  ```
  curl -sS -X POST -H "Circle-Token: $CIRCLECI_TOKEN" \
    https://circleci.com/api/v2/workflow/<workflowId>/rerun \
    -H 'content-type: application/json' -d '{"from_failed":true}'
  ```
  If the same tests flake repeatedly, harden them (raise the `waitFor` timeout) rather than re-running forever.

## Notes

- The v1.1 API is officially "deprecated" but is currently the only route to raw step output for App-integration projects; if it ever stops, fall back to reproducing locally.
- Log chunks can be gzipped without a `content-encoding` header — the script gunzips on JSON-parse failure.
