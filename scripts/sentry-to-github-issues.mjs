#!/usr/bin/env node
// Mirrors an unresolved Sentry issue into a GitHub issue titled `STASH-N: <title>`.
// Idempotent by design: before creating anything it searches GitHub for an
// issue whose title already contains the shortId, so re-running (e.g. on a
// schedule) only files issues for Sentry reports that don't have one yet —
// no separate "last synced" state to keep in sync with reality.

import fs from 'node:fs';
import path from 'node:path';

const SENTRY_API_BASE = 'https://sentry.io/api/0';
const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_SENTRY_ORG = 'self-463';
const DEFAULT_SENTRY_PROJECT = 'stash';
// Safety bound on how many unresolved Sentry issues a single run will page
// through looking for untracked ones — independent of --limit (which caps how
// many new GitHub issues get *created* per run) so a large backlog doesn't
// starve older issues that fall past the first page.
const MAX_SCAN = 500;

function readDotEnv(file) {
  if (!file || !fs.existsSync(file)) return {};
  const env = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadConfig(args) {
  const cwdEnv = readDotEnv(path.join(process.cwd(), '.env.local'));
  const pointerEnv = readDotEnv(process.env.SENTRY_ENV_FILE);
  const repo =
    args.repo || process.env.GITHUB_REPOSITORY || cwdEnv.GITHUB_REPOSITORY || null;
  const [owner, name] = repo ? repo.split('/') : [null, null];
  return {
    sentryToken:
      process.env.SENTRY_AUTH_TOKEN || cwdEnv.SENTRY_AUTH_TOKEN || pointerEnv.SENTRY_AUTH_TOKEN,
    // Default to the Stash Sentry scope so a manual run without SENTRY_ORG/
    // SENTRY_PROJECT set can't enumerate every org a broader token can see
    // and file unrelated issues into this repo.
    sentryOrg:
      process.env.SENTRY_ORG || cwdEnv.SENTRY_ORG || pointerEnv.SENTRY_ORG || DEFAULT_SENTRY_ORG,
    sentryProject:
      process.env.SENTRY_PROJECT ||
      cwdEnv.SENTRY_PROJECT ||
      pointerEnv.SENTRY_PROJECT ||
      DEFAULT_SENTRY_PROJECT,
    githubToken: process.env.GITHUB_TOKEN || cwdEnv.GITHUB_TOKEN,
    githubOwner: owner,
    githubRepo: name,
  };
}

// In-app feedback reports (Sentry tag logger:feedback-bridge, source:
// in-app-feedback — see supabase/functions/feedback-bridge/sentry-sink.ts)
// carry the reporter's own free-form message as issue.title, which can
// contain names, emails, or other details a user typed expecting private
// support, not a public GitHub issue. Excluded from the default query;
// pass --query explicitly to include them for a deliberate, reviewed sync.
const DEFAULT_QUERY = 'is:unresolved !logger:feedback-bridge';

function parseArgs(argv) {
  const args = { limit: 20, dryRun: false, query: DEFAULT_QUERY, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--query') args.query = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  pnpm sentry:sync-github-issues
  pnpm sentry:sync-github-issues --dry-run
  pnpm sentry:sync-github-issues --limit 5 --query "is:unresolved level:fatal"

Pages through unresolved Sentry issues (newest first, up to ${MAX_SCAN},
default query excludes logger:feedback-bridge — see comment above
DEFAULT_QUERY) and creates a GitHub issue for each one that doesn't already
have one — matched by "STASH-N" in the GitHub issue title — stopping once
--limit (default 20) new issues have been created in this run; any left over
are picked up next run. Safe to re-run on a schedule: already-migrated issues
are skipped.

Environment:
  SENTRY_AUTH_TOKEN — from the shell, .env.local, or the file pointed to by
  SENTRY_ENV_FILE (see sentry-issue.mjs).
  SENTRY_ORG/SENTRY_PROJECT — default to '${DEFAULT_SENTRY_ORG}'/'${DEFAULT_SENTRY_PROJECT}'.
  GITHUB_TOKEN — a token with 'issues: write' on the target repo.
  GITHUB_REPOSITORY — "owner/repo" (set automatically in GitHub Actions),
  or pass --repo owner/repo.`);
}

async function sentryGet(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sentry ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return { data: text ? JSON.parse(text) : null, linkHeader: response.headers.get('link') };
}

// Sentry paginates with a GitHub-style Link header, e.g.:
//   <url>; rel="previous"; results="false"; cursor="...", <url>; rel="next"; results="true"; cursor="..."
// `results="true"` is the actual "is there more data" signal — a `rel="next"`
// link is always present even on the last page, just with results="false".
function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const urlMatch = part.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    if (/rel="next"/.test(part) && /results="true"/.test(part)) return urlMatch[1];
  }
  return null;
}

// Pages through unresolved Sentry issues (newest first) up to MAX_SCAN, so a
// large backlog is fully visible to the dedup pass instead of only its first
// page — the number of GitHub issues actually *created* is throttled
// separately by --limit in run().
async function searchSentryIssues(config, query) {
  const url = new URL(`${SENTRY_API_BASE}/organizations/${config.sentryOrg}/issues/`);
  url.searchParams.set('sort', 'date');
  url.searchParams.set('limit', '100');
  url.searchParams.set('query', query);
  if (config.sentryProject) url.searchParams.set('project', config.sentryProject);

  const issues = [];
  let next = url.toString();
  while (next && issues.length < MAX_SCAN) {
    const { data, linkHeader } = await sentryGet(next, config.sentryToken);
    for (const issue of data) issues.push(issue);
    next = nextPageUrl(linkHeader);
  }
  return issues.slice(0, MAX_SCAN);
}

async function latestSentryEvent(config, issue) {
  const { data } = await sentryGet(`${SENTRY_API_BASE}/issues/${issue.id}/events/latest/`, config.sentryToken);
  return data;
}

function eventTag(event, key) {
  return Array.isArray(event?.tags) ? event.tags.find((tag) => tag.key === key)?.value : null;
}

async function githubRequest(method, urlPath, config, body) {
  const response = await fetch(`${GITHUB_API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

const SHORT_ID_PREFIX = /^([A-Z][A-Z0-9_-]*-[A-Z0-9]+):/;

// Fetches every already-migrated shortId once via the repo issues list
// (5000 req/hr core rate limit) instead of one Search API call per Sentry
// issue (30 req/min, and counted against the whole token/repo) — a backlog
// of already-tracked issues would otherwise exhaust that limit and make the
// scheduled run fail at the same point, every run, before ever reaching the
// untracked tail.
async function fetchTrackedShortIds(config) {
  const tracked = new Map();
  let page = 1;
  while (page <= 20) {
    const result = await githubRequest(
      'GET',
      `/repos/${config.githubOwner}/${config.githubRepo}/issues?state=all&per_page=100&page=${page}`,
      config,
    );
    for (const item of result) {
      if (item.pull_request) continue;
      const match = item.title.match(SHORT_ID_PREFIX);
      if (match) tracked.set(match[1], item.number);
    }
    if (result.length < 100) break;
    page += 1;
  }
  return tracked;
}

function buildIssueBody(issue, event) {
  const release = event?.release?.version || event?.release || eventTag(event, 'release') || 'unknown';
  const platform = eventTag(event, 'os') || eventTag(event, 'os.name') || issue.platform || 'unknown';
  const device = eventTag(event, 'device.family') || eventTag(event, 'device') || null;
  const message = event?.title || event?.message || issue.title;
  const frames = event?.entries?.find((e) => e.type === 'exception')?.data?.values?.[0]?.stacktrace?.frames;
  const stacktrace = Array.isArray(frames)
    ? frames
        .slice(-15)
        .reverse()
        .map((f) => `    at ${f.function || '<unknown>'} (${f.filename || f.module || '<unknown>'})`)
        .join('\n')
    : null;

  return `**Reported via Sentry**: [${issue.shortId}](${issue.permalink})

## Summary
${message}

## Details
- **Handled**: ${eventTag(event, 'handled') === 'no' ? 'no (fatal)' : (eventTag(event, 'handled') ?? 'unknown')}
- **Release**: \`${release}\`
- **Platform**: ${platform}${device ? ` (${device})` : ''}
- **First/Last seen**: ${issue.firstSeen} / ${issue.lastSeen}
- **Occurrences**: ${issue.count} (${issue.userCount} user${issue.userCount === '1' ? '' : 's'} impacted)
${stacktrace ? `\n### Stacktrace\n\`\`\`\n${stacktrace}\n\`\`\`\n` : ''}
---
_Filed automatically by the Sentry → GitHub issue sync workflow (\`scripts/sentry-to-github-issues.mjs\`)._`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);
  if (!config.sentryToken) throw new Error('SENTRY_AUTH_TOKEN is required.');
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is required.');
  if (!config.githubOwner || !config.githubRepo) {
    throw new Error('GITHUB_REPOSITORY (owner/repo) is required, or pass --repo owner/repo.');
  }

  const [issues, tracked] = await Promise.all([
    searchSentryIssues(config, args.query),
    fetchTrackedShortIds(config),
  ]);
  console.log(`Scanned ${issues.length} Sentry issue(s) matching "${args.query}".`);

  let created = 0;
  let skipped = 0;
  for (const issue of issues) {
    if (created >= args.limit) {
      console.log(`Reached --limit ${args.limit}; remaining issues will be picked up next run.`);
      break;
    }
    if (!issue.shortId) continue;
    const existingNumber = tracked.get(issue.shortId);
    if (existingNumber) {
      console.log(`skip:    ${issue.shortId} already tracked as #${existingNumber}`);
      skipped += 1;
      continue;
    }

    const title = `${issue.shortId}: ${issue.title}`.slice(0, 250);
    if (args.dryRun) {
      console.log(`would create: ${title}`);
      created += 1;
      continue;
    }

    const event = await latestSentryEvent(config, issue).catch(() => null);
    const body = buildIssueBody(issue, event);
    const created_issue = await githubRequest('POST', `/repos/${config.githubOwner}/${config.githubRepo}/issues`, config, {
      title,
      body,
    });
    console.log(`created: ${issue.shortId} -> #${created_issue.number} ${created_issue.html_url}`);
    created += 1;
  }

  console.log(`\nDone. Created ${created}, skipped ${skipped}.`);
}

await run();
