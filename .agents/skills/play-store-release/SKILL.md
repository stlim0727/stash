---
name: play-store-release
description: >-
  Prepare, verify, and submit the Keepory Android app to Google Play. Use when
  the user asks to publish to Play Store, prepare a Play release, create or
  update Play Console metadata, build a production AAB, submit with EAS, manage
  closed/internal testing, answer Play Data safety/App content questions, or
  diagnose Play submission blockers. Grounds the workflow in
  docs/development/play-store.md, app.json, eas.json, and the live repo state.
---

# Play Store Release

Operational checklist for Keepory on Google Play. The authoritative guide is
`docs/development/play-store.md`; release mechanics still come from
`docs/development/releasing.md`. If this skill disagrees with those files, the
docs win and this skill should be fixed.

## Non-negotiables

- Android package is `com.keepory.app`. Verify before creating or uploading to a
  Play Console app; package names cannot be changed after publication.
- Play builds are EAS production `.aab` builds. Do not upload the internal
  debug-signed APK from `.github/workflows/android-apk.yml`.
- Public policy URLs should be:
  - `https://keepory.app/privacy.html`
  - `https://keepory.app/account-deletion.html`
- There is no Google Play Console MCP connector available in this environment.
  Use Play Console manually, or EAS Submit / Google Play Developer API when
  credentials are configured.
- If the Play account is a new personal developer account, plan for the Google
  closed-testing gate: at least 12 opted-in testers for 14 continuous days before
  production access.

## Step 1 - Read current state

Check these before proposing actions:

```sh
git status --short --branch
git log -1 --oneline
Get-Content apps/mobile/app.json
Get-Content apps/mobile/eas.json
Get-Content docs/development/play-store.md
```

Confirm:

- `expo.name` is `Keepory`.
- `android.package` is `com.keepory.app`.
- `ios.bundleIdentifier` is `com.keepory.app` unless intentionally diverging.
- `expo.version` is the intended release version.
- Production EAS profile exists.
- `docs/privacy.html` and `docs/account-deletion.html` exist.

## Step 2 - Finish Play Console prerequisites

Have the user do UI-only/account-only work when needed:

- Create the Play Console app with package `com.keepory.app`.
- Enroll in Play App Signing.
- Add support contact details.
- Add testers for internal/closed testing.
- If using EAS Submit, create a Google service account key with Play Console
  permissions and configure it in EAS credentials. Do not commit the JSON key.

## Step 3 - Prepare metadata

Use `docs/development/play-store.md` as the starting point for:

- Short description.
- Full description.
- App category.
- Data safety working notes.
- App content declarations.
- QA checklist.

When answering Data safety questions, distinguish verified facts from
inferences. Do not claim local data encryption at rest; local bookmark
encryption is still future work.

## Step 4 - Build the store artifact

From `apps/mobile`:

```sh
corepack pnpm dlx eas-cli login
corepack pnpm dlx eas-cli build --profile production --platform android
```

Expected artifact: Android App Bundle (`.aab`). If submitting through EAS:

```sh
corepack pnpm dlx eas-cli submit --platform android
```

Only run submit after the Play Console app exists and Google service-account
credentials are configured.

## Step 5 - Verify before upload or rollout

Run repo checks when code/config changed:

```sh
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:components
```

Inspect the downloaded `.aab` when available:

```sh
bundletool dump manifest --bundle app-release.aab
```

Confirm:

- Package is `com.keepory.app`.
- Target SDK is at least the current Play requirement.
- Version code is higher than prior Play uploads.
- No unexpected dangerous permissions appear.

Then real-device smoke test the Play-bound build. Native SQLite and
share-intent are the highest-risk path; do not treat web/export tests as proof.

## Step 6 - Tracks and rollout

Recommended first submission path:

1. Internal testing.
2. Closed testing if required by the account.
3. Apply for production access if Play requires it.
4. Production rollout only after Play pre-launch report and real-device smoke
   testing are clean.

For new personal developer accounts, maintain the 12-tester/14-day condition
continuously before applying for production access.
