---
name: fetch-sentry-issues
description: Check Sentry configuration/tokens and fetch latest unresolved Sentry issues for Stash using the Sentry API or CLI helper scripts. Use when the user asks to inspect Sentry credentials, list open Sentry errors, check STASH-N issues, or verify Sentry integration.
---

# Fetch Sentry Issues & Verification Skill

Use this procedure to check Sentry credentials and query unresolved issues/telemetry for the `stash` project (`self-463/stash`).

## 1. Credentials Check & Priority

Sentry access requires `SENTRY_AUTH_TOKEN` (API/CLI) and `EXPO_PUBLIC_SENTRY_DSN` (Client SDK).

The token resolution order for API/CLI scripts is:
1. Environment variables (`process.env.SENTRY_AUTH_TOKEN`)
2. Local user config (`C:\Users\stlim\.env.local` / `../.env.local`)
3. Repo local config (`.env.local` / `.env`)

### Credentials Summary:
* **API/CLI Token:** `SENTRY_AUTH_TOKEN` in `../.env.local`
* **Sentry Organization:** `self-463` (default)
* **Sentry Project:** `stash` (default)
* **Client DSN:** `EXPO_PUBLIC_SENTRY_DSN` in `.env` or `.env.local` (optional for local dev, required for error ingestion in builds)

## 2. Procedure: Fetching Unresolved Issues

To list the latest unresolved issues from Sentry via Node fetch API:

```javascript
import fs from 'node:fs';

function getAuthToken() {
  if (process.env.SENTRY_AUTH_TOKEN) return process.env.SENTRY_AUTH_TOKEN;
  if (fs.existsSync('../.env.local')) {
    const content = fs.readFileSync('../.env.local', 'utf8');
    const match = content.match(/SENTRY_AUTH_TOKEN=(.*)/);
    if (match) return match[1].trim();
  }
  return null;
}

const token = getAuthToken();
const org = process.env.SENTRY_ORG || 'self-463';
const project = process.env.SENTRY_PROJECT || 'stash';

const res = await fetch(`https://sentry.io/api/0/projects/${org}/${project}/issues/?query=is:unresolved&sort=date`, {
  headers: { Authorization: `Bearer ${token}` }
});

const issues = await res.json();
console.log(`Found ${issues.length} unresolved Sentry issues:`);
issues.forEach((i) => {
  console.log(`${i.shortId} | ${i.title} | Events: ${i.count} | Users: ${i.userCount} | Last: ${i.lastSeen}`);
});
```

## 3. CLI Helper Commands

- **Inspect specific issue details:**
  ```bash
  pnpm sentry:issue STASH-52
  ```
- **Sync unresolved Sentry issues to GitHub issues:**
  ```bash
  pnpm sentry:sync-github-issues
  ```
- **Verify client-side DSN pipeline:**
  ```bash
  EXPO_PUBLIC_SENTRY_DSN="<dsn>" pnpm verify:sentry
  ```
