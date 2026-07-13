#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://sentry.io/api/0';

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

function loadConfig() {
  const cwdEnv = readDotEnv(path.join(process.cwd(), '.env.local'));
  const pointerEnv = readDotEnv(process.env.SENTRY_ENV_FILE);
  return {
    token: process.env.SENTRY_AUTH_TOKEN || cwdEnv.SENTRY_AUTH_TOKEN || pointerEnv.SENTRY_AUTH_TOKEN,
    org: process.env.SENTRY_ORG || cwdEnv.SENTRY_ORG || pointerEnv.SENTRY_ORG || null,
    project:
      process.env.SENTRY_PROJECT || cwdEnv.SENTRY_PROJECT || pointerEnv.SENTRY_PROJECT || null,
  };
}

function parseArgs(argv) {
  const args = {
    shortId: null,
    release: null,
    resolve: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--release') args.release = argv[++i] || null;
    else if (arg === '--resolve') args.resolve = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!args.shortId) {
      args.shortId = arg.toUpperCase();
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!args.shortId) throw new Error('Missing Sentry short id, for example STASH-22.');
  if (!/^[A-Z][A-Z0-9_-]*-[A-Z0-9]+$/i.test(args.shortId)) {
    throw new Error(`Invalid Sentry short id: ${args.shortId}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  pnpm sentry:issue STASH-22
  pnpm sentry:issue STASH-22 --release 1.2.0-rc5
  pnpm sentry:issue STASH-22 --resolve

Environment:
  Reads SENTRY_AUTH_TOKEN plus optional SENTRY_ORG/SENTRY_PROJECT from the shell,
  .env.local, or the file pointed to by SENTRY_ENV_FILE.`);
}

async function getJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getOrgs(config) {
  if (config.org) return [{ slug: config.org }];
  return getJson(`${API_BASE}/organizations/`, config.token);
}

async function searchIssues(config, query, limit = 10) {
  const issues = [];
  for (const org of await getOrgs(config)) {
    const url = new URL(`${API_BASE}/organizations/${org.slug}/issues/`);
    url.searchParams.set('sort', 'date');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('query', query);
    url.searchParams.set('shortIdLookup', '1');
    if (config.project) url.searchParams.set('project', config.project);
    const found = await getJson(url.toString(), config.token);
    for (const issue of found) issues.push({ org: org.slug, ...issue });
  }
  issues.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  return issues;
}

async function latestEvent(config, issue) {
  return getJson(`${API_BASE}/issues/${issue.id}/events/latest/`, config.token);
}

async function resolveIssue(config, issue) {
  return getJson(`${API_BASE}/organizations/${issue.org}/issues/${issue.id}/`, config.token, {
    method: 'PUT',
    body: JSON.stringify({ status: 'resolved' }),
  });
}

function eventTag(event, key) {
  return Array.isArray(event.tags) ? event.tags.find((tag) => tag.key === key)?.value : null;
}

function compactIssue(issue, event = null) {
  return {
    id: issue.id,
    shortId: issue.shortId,
    title: issue.title,
    status: issue.status,
    level: issue.level,
    count: issue.count,
    userCount: issue.userCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    latestRelease: event ? event.release?.version || event.release || eventTag(event, 'release') : null,
    permalink: issue.permalink,
  };
}

function printHuman({ issue, release, releaseMatched, resolved }) {
  console.log(`${issue.shortId} - ${issue.title}`);
  console.log(`Status: ${issue.status}`);
  console.log(`Count: ${issue.count}; users: ${issue.userCount}`);
  console.log(`First seen: ${issue.firstSeen}`);
  console.log(`Last seen: ${issue.lastSeen}`);
  if (issue.latestRelease) console.log(`Latest release: ${issue.latestRelease}`);
  if (release) console.log(`Seen in ${release}: ${releaseMatched ? 'yes' : 'no'}`);
  if (resolved) console.log('Action: resolved');
  console.log(issue.permalink);
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
if (!config.token) {
  throw new Error('SENTRY_AUTH_TOKEN is required in the environment, .env.local, or SENTRY_ENV_FILE.');
}

const baseMatches = await searchIssues(config, `issue:${args.shortId}`, 10);
const issue = baseMatches.find((candidate) => candidate.shortId === args.shortId) || baseMatches[0];
if (!issue) throw new Error(`No Sentry issue found for ${args.shortId}.`);

let releaseMatched = null;
if (args.release) {
  const releaseMatches = await searchIssues(config, `issue:${args.shortId} release:${args.release}`, 10);
  releaseMatched = releaseMatches.some((candidate) => candidate.shortId === args.shortId);
}

let resolved = false;
let currentIssue = issue;
if (args.resolve && issue.status !== 'resolved') {
  currentIssue = await resolveIssue(config, issue);
  resolved = true;
}

const event = await latestEvent(config, currentIssue);
const latest = compactIssue(currentIssue, event);
const output = {
  issue: latest,
  release: args.release,
  releaseMatched,
  resolved,
};

if (args.json) console.log(JSON.stringify(output, null, 2));
else printHuman(output);
