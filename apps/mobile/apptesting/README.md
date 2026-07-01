# App Testing Agent — YAML test cases

The files in this directory are natural-language test cases for the Gemini-powered
[Firebase App Testing Agent](https://firebase.google.com/docs/app-distribution/android/app-testing-agent).
Each one describes user journeys in plain English; the agent installs the app on
a real device in Firebase Test Lab, follows the steps, and judges each assertion.

They live in the repo (not only in the Firebase console) so test cases are
versioned, reviewed in PRs, and runnable from the CLI and CI.

## Files

| File | Surface |
| --- | --- |
| `capture.yaml` | The Add modal: save a URL + note, invalid-URL error, idempotent duplicate save. |
| `inbox.yaml` | Inbox list: view-mode switch, sort, search + clear, no-match empty state. |
| `detail-and-ai.yaml` | Bookmark detail: edit title/notes (auto-save), add/remove tags, reassign collection. |
| `organize.yaml` | Long-press move-to-collection, tag-cloud facet, AI-suggestion review (best-effort). |
| `trash.yaml` | Trash → view → restore, empty-trash cancel vs. confirm. |
| `settings.yaml` | Language, export action sheet, sync status, developer mode, report-a-problem. |

## YAML format

Each file holds a `tests:` list. Every test has a `displayName`, a **globally
unique** `id` (the agent shares one id namespace per run), and ordered `steps`.
Each step has a `goal` (imperative, natural language) and a `finalScreenAssertion`
(what must be observably true afterwards). Optional: `hint` to disambiguate, and
`prerequisiteTestCaseId` to chain a test onto another by id.

```yaml
tests:
- displayName: Add a bookmark
  id: capture-add-bookmark
  prerequisiteTestCaseId: capture-app-loaded   # optional: run after this id
  steps:
  - goal: Open the Add screen and save the URL "https://example.com"
    hint: Tap the add/FAB button, type the URL, then Save        # optional
    finalScreenAssertion: A card for example.com appears in the Inbox.
```

Write goals as **user intent, not pixel taps** — the agent navigates the UI, so
describe what the user wants ("save the URL", "switch to compact view"), not exact
coordinates. Keep assertions to something visible on screen. Lean on the product
invariants when asserting: capture is optimistic (the item appears immediately),
AI enrichment never overwrites user-typed fields, and deletes archive by default.

## Add a case

1. Pick the file for the surface (or add a new `*.yaml`).
2. Add a `tests:` entry with a unique `id` (prefix by file, e.g. `inbox-…`).
3. Write `steps` with `goal` + `finalScreenAssertion`; chain with
   `prerequisiteTestCaseId` if it needs a pre-existing bookmark.
4. Validate locally against a real release before opening a PR.

## Run locally

```bash
npm install -g firebase-tools
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export FIREBASE_APP_ID=1:1234567890:android:abcdef

# all cases (uses the last App Distribution release — no APK arg)
pnpm test:apptesting

# a subset by name regex
firebase apptesting:execute --app "$FIREBASE_APP_ID" \
  --test-dir apps/mobile/apptesting \
  --test-devices "model=shiba,version=34,locale=en,orientation=portrait" \
  --test-name-pattern "capture"
```

Omitting the binary makes the agent test the **last release uploaded to Firebase
App Distribution**. The service account needs the **Firebase App Testing Admin**
(`roles/firebaseapptesting.admin`) + **Firebase App Distribution Admin** roles —
with only App Distribution Admin, the run authenticates and finds the release but
fails with `403 PERMISSION_DENIED` when it tries to create the release test.

## Run in CI

`.github/workflows/app-testing.yml` runs the same command — manually
(`workflow_dispatch`, with overridable `test-devices` / `test-name-pattern`) or
chained after a build (`workflow_call`). It skips cleanly when the Firebase
secrets are absent.

## Find test devices

The `--test-devices` value is a comma-separated spec
(`model=...,version=...,locale=...,orientation=...`); separate multiple devices
with `;`. List available models and supported API versions with:

```bash
gcloud firebase test android models list      # model ids (e.g. shiba = Pixel 8)
gcloud firebase test android versions list    # supported API levels
```

The repo default is `model=shiba,version=34,locale=en,orientation=portrait`
(Pixel 8, API 34).
