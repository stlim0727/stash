#!/usr/bin/env node
// Fetch the failing step logs for a CircleCI workflow — for GitHub-App projects
// where the classic v1.1 endpoints 404 on the gh/{org}/{repo} slug and there is
// no documented v2 raw-log endpoint. The trick: v1.1 single-build DOES work if
// you pass the *triplet* project slug (circleci/{orgId}/{projId}) that the v2
// API reports, and each step action carries a presigned `output_url`.
//
// Usage:
//   CIRCLECI_TOKEN=... node fetch-failure.mjs <workflow-id | circleci-url> [tailLines]
//
// Accepts a bare workflow UUID or any CircleCI URL containing one
// (e.g. https://app.circleci.com/pipelines/.../workflows/<uuid> or the
// commit-status target_url https://app.circleci.com/workflow/<uuid>).
import zlib from 'node:zlib';

const TOKEN = process.env.CIRCLECI_TOKEN;
if (!TOKEN) {
  console.error('Set CIRCLECI_TOKEN (a CircleCI personal API token).');
  process.exit(2);
}
const arg = process.argv[2];
const TAIL = Number(process.argv[3] || 120);
if (!arg) {
  console.error('Usage: node fetch-failure.mjs <workflow-id|circleci-url> [tailLines]');
  process.exit(2);
}
const m = arg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
const workflowId = m ? m[0] : arg;

const api = (path) =>
  fetch(`https://circleci.com${path}`, { headers: { 'Circle-Token': TOKEN } }).then(async (r) => {
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
  });

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function fetchStepLog(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  let text;
  try {
    text = buf.toString('utf8');
    JSON.parse(text); // if this parses, it wasn't gzipped
  } catch {
    try {
      text = zlib.gunzipSync(buf).toString('utf8');
    } catch {
      text = buf.toString('utf8');
    }
  }
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return stripAnsi(arr.map((x) => x.message || '').join(''));
  } catch {
    /* not the {message:[]} shape */
  }
  return stripAnsi(text);
}

(async () => {
  const wf = await api(`/api/v2/workflow/${workflowId}`).catch(() => null);
  if (wf) console.log(`workflow: ${wf.name} — status ${wf.status}`);
  const { items: jobs } = await api(`/api/v2/workflow/${workflowId}/job`);
  const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'timedout');
  if (!failed.length) {
    console.log('No failed jobs in this workflow. Job statuses:');
    for (const j of jobs) console.log(`  ${j.status}\t${j.name}`);
    return;
  }
  for (const job of failed) {
    console.log(`\n══ FAILED JOB #${job.job_number} · ${job.name} ══`);
    const slug = job.project_slug; // circleci/{orgId}/{projId}
    const build = await api(`/api/v1.1/project/${slug}/${job.job_number}`).catch((e) => {
      console.log(`  (v1.1 fetch failed: ${e.message})`);
      return null;
    });
    if (!build?.steps) continue;
    for (const step of build.steps) {
      for (const a of step.actions) {
        const failedAction = a.failed || (a.exit_code != null && a.exit_code !== 0);
        if (!failedAction || !a.output_url) continue;
        console.log(`\n── failing step: "${step.name}" (exit ${a.exit_code}) ──`);
        const log = await fetchStepLog(a.output_url);
        // Surface the jest/test failure markers, then the tail.
        const markers = log
          .split('\n')
          .filter((l) => /(FAIL |✕|●|Error:|Unable to find|Timed out|expect\(|Exit status|not ok)/.test(l))
          .slice(0, 40);
        if (markers.length) {
          console.log('  ‣ failure markers:');
          for (const l of markers) console.log('   ', l.slice(0, 200));
        }
        console.log(`\n  ‣ last ${TAIL} lines:`);
        console.log(
          log
            .split('\n')
            .slice(-TAIL)
            .map((l) => '   ' + l)
            .join('\n'),
        );
      }
    }
  }
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
