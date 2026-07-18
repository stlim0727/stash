import fs from 'node:fs';

async function check() {
  const env = fs.readFileSync('.env.local', 'utf8');
  const tokenLine = env.split('\n').find(l => l.startsWith('SENTRY_AUTH_TOKEN='));
  if (!tokenLine) {
    console.log("No SENTRY_AUTH_TOKEN found in .env.local");
    return;
  }
  const token = tokenLine.split('=')[1].replace(/['"]/g, '').trim();

  const url = 'https://sentry.io/api/0/projects/self-463/stash/issues/?query=is:unresolved&limit=10';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    console.log("Error:", res.status, res.statusText, await res.text());
    return;
  }

  const issues = await res.json();
  if (!issues || issues.length === 0) {
    console.log("No unresolved issues!");
    return;
  }

  for (const i of issues) {
    console.log(`${i.shortId} - ${i.title} - ${i.permalink}`);
  }
}

check();
