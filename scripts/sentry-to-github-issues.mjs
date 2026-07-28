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
    sentryOrg: process.env.SENTRY_ORG || cwdEnv.SENTRY_ORG || pointerEnv.SENTRY_ORG || null,
    sentryProject:
      process.env.SENTRY_PROJECT || cwdEnv.SENTRY_PROJECT || pointerEnv.SENTRY_PROJECT || null,
    githubToken: process.env.GITHUB_TOKEN || cwdEnv.GITHUB_TOKEN,
    githubOwner: owner,
    githubRepo: name,
  };
}

function parseArgs(argv) {
  const args = { limit: 20, dryRun: false, query: 'is:unresolved', repo: null };
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

Creates a GitHub issue for each unresolved Sentry issue (newest first, up to
--limit) that doesn't already have one — matched by "STASH-N" in the GitHub
issue title. Safe to re-run on a schedule: already-migrated issues are skipped.

Environment:
  SENTRY_AUTH_TOKEN, optional SENTRY_ORG/SENTRY_PROJECT — from the shell,
  .env.local, or the file pointed to by SENTRY_ENV_FILE (see sentry-issue.mjs).
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
  return text ? JSON.parse(text) : null;
}

async function searchSentryIssues(config, query, limit) {
  const orgs = config.sentryOrg ? [config.sentryOrg] : (await sentryGet(`${SENTRY_API_BASE}/organizations/`, config.sentryToken)).map((o) => o.slug);
  const issues = [];
  for (const org of orgs) {
    const url = new URL(`${SENTRY_API_BASE}/organizations/${org}/issues/`);
    url.searchParams.set('sort', 'date');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('query', query);
    if (config.sentryProject) url.searchParams.set('project', config.sentryProject);
    const found = await sentryGet(url.toString(), config.sentryToken);
    for (const issue of found) issues.push({ org, ...issue });
  }
  issues.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  return issues.slice(0, limit);
}

async function latestSentryEvent(config, issue) {
  return sentryGet(`${SENTRY_API_BASE}/issues/${issue.id}/events/latest/`, config.sentryToken);
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

async function findExistingGithubIssue(config, shortId) {
  const q = `repo:${config.githubOwner}/${config.githubRepo} in:title "${shortId}" type:issue`;
  const result = await githubRequest('GET', `/search/issues?q=${encodeURIComponent(q)}`, config);
  return result.items.find((item) => item.title.startsWith(`${shortId}:`)) || result.items[0] || null;
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

  const issues = await searchSentryIssues(config, args.query, args.limit);
  console.log(`Found ${issues.length} Sentry issue(s) matching "${args.query}".`);

  let created = 0;
  let skipped = 0;
  for (const issue of issues) {
    if (!issue.shortId) continue;
    const existing = await findExistingGithubIssue(config, issue.shortId);
    if (existing) {
      console.log(`skip:    ${issue.shortId} already tracked as #${existing.number}`);
      skipped += 1;
      continue;
    }

    const title = `${issue.shortId}: ${issue.title}`.slice(0, 250);
    if (args.dryRun) {
      console.log(`would create: ${title}`);
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
