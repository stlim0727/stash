// Prune old Firebase App Distribution releases via the REST API, using a
// service-account token. Mirrors firebase-app-distribution.mjs: it deliberately
// avoids `firebase-tools` (whose service-account CLI auth is broken in CI,
// firebase/firebase-tools#10041) and mints a token straight from the SA key.
//
// Policy: sort releases newest-first, always keep the most recent KEEP of them,
// then among the rest delete those older than MAX_AGE_DAYS. With MAX_AGE_DAYS=0
// every release beyond KEEP is deleted. The newest KEEP are never touched, so a
// too-aggressive age can't wipe out your latest build.
//
// Inputs (env):
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account JSON key
//   FIREBASE_APP_ID                 e.g. 1:1234567890:android:abcdef
//   KEEP                            keep the N most recent releases (default 20)
//   MAX_AGE_DAYS                    delete releases older than N days (default 0 = ignore age)
//   DRY_RUN                         "true" to only report what would be deleted
//
// Never prints the key or the access token. Exits non-zero on failure.

import https from "node:https";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://firebaseappdistribution.googleapis.com";
const fail = (msg) => {
  console.error(`::error::Firebase App Distribution cleanup: ${msg}`);
  process.exit(1);
};

// Parse a non-negative-integer input. Empty/unset falls back to `fallback`;
// anything else that isn't a non-negative integer fails closed rather than
// silently coercing to 0 — a typo like "seven" must not disable the age filter
// (delete everything) or zero out the newest-release safety net.
function intInput(name, raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    fail(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return parseInt(raw, 10);
}

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Mint an OAuth access token from the service-account key (RS256 JWT bearer).
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claim =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  let assertion;
  try {
    const s = crypto.createSign("RSA-SHA256");
    s.update(claim);
    s.end();
    assertion = claim + "." + s.sign(sa.private_key, "base64url");
  } catch (e) {
    fail(`service-account private_key is not a usable PEM (${e.code || e.message})`);
  }
  const body =
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + assertion;
  const res = await request("POST", "https://oauth2.googleapis.com/token", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  if (res.status !== 200 || !res.json?.access_token) {
    fail(
      `token mint failed (status ${res.status}, ${res.json?.error || "?"}: ${res.json?.error_description || ""})`,
    );
  }
  return res.json.access_token;
}

// Pure selection: given releases (each {name, createTime}), decide which to
// delete. Exported for unit testing without any network.
export function selectReleasesToDelete(releases, { keep, maxAgeDays, now }) {
  const sorted = [...releases].sort(
    (a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime(),
  );
  const candidates = sorted.slice(keep); // protect the newest `keep`
  if (!maxAgeDays) return candidates;
  const cutoff = now - maxAgeDays * 86400 * 1000;
  return candidates.filter((r) => new Date(r.createTime).getTime() < cutoff);
}

async function listAllReleases(appName, token) {
  const releases = [];
  let pageToken = "";
  do {
    const url =
      `${API}/v1/${appName}/releases?pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await request("GET", url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) {
      fail(`list releases failed (status ${res.status}): ${res.text?.slice(0, 300)}`);
    }
    for (const r of res.json.releases || []) releases.push(r);
    pageToken = res.json.nextPageToken || "";
  } while (pageToken);
  return releases;
}

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const appId = process.env.FIREBASE_APP_ID;
  const keep = intInput("KEEP", process.env.KEEP, 20);
  const maxAgeDays = intInput("MAX_AGE_DAYS", process.env.MAX_AGE_DAYS, 0);
  const dryRun = process.env.DRY_RUN === "true";

  if (!keyPath || !appId) {
    fail("missing GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_APP_ID");
  }

  const sa = JSON.parse(readFileSync(keyPath, "utf8"));
  const projectNumber = appId.split(":")[1];
  if (!projectNumber) fail(`could not parse project number from app id "${appId}"`);
  const appName = `projects/${projectNumber}/apps/${appId}`;

  const token = await getAccessToken(sa);
  console.log(`Authenticated as ${sa.client_email}; listing releases for ${appName}`);

  const releases = await listAllReleases(appName, token);
  console.log(
    `Found ${releases.length} release(s). Policy: keep newest ${keep}` +
      (maxAgeDays ? `, delete the rest older than ${maxAgeDays} day(s).` : ", delete the rest."),
  );

  const toDelete = selectReleasesToDelete(releases, {
    keep,
    maxAgeDays,
    now: Date.now(),
  });

  if (!toDelete.length) {
    console.log("Nothing to delete.");
    return;
  }

  for (const r of toDelete) {
    const ver = r.releaseVersion?.displayVersion || r.displayVersion || "";
    console.log(`  - ${r.name}  ${r.createTime}${ver ? `  (${ver})` : ""}`);
  }

  if (dryRun) {
    console.log(`DRY RUN: would delete ${toDelete.length} release(s). No changes made.`);
    return;
  }

  // batchDelete accepts at most 100 names per call.
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 100) {
    const names = toDelete.slice(i, i + 100).map((r) => r.name);
    const res = await request("POST", `${API}/v1/${appName}/releases:batchDelete`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ names }),
    });
    if (res.status !== 200) {
      fail(`batchDelete failed (status ${res.status}): ${res.text?.slice(0, 300)}`);
    }
    deleted += names.length;
    console.log(`Deleted ${deleted}/${toDelete.length}...`);
  }
  console.log(`Firebase App Distribution cleanup complete: deleted ${deleted} release(s).`);
}

// Only run when invoked directly, so the pure selector can be imported in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message || String(e)));
}
