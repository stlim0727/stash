// Upload an APK to Firebase App Distribution and distribute it to tester groups,
// talking to the App Distribution REST API directly with a service-account
// token. This deliberately avoids `firebase-tools`, whose CLI auth via
// GOOGLE_APPLICATION_CREDENTIALS is broken for service accounts in CI
// (firebase/firebase-tools#10041) — minting a token straight from the SA key
// works, so we do exactly that and skip the CLI.
//
// Inputs (env):
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account JSON key
//   FIREBASE_APP_ID                 e.g. 1:1234567890:android:abcdef
//   FIREBASE_TESTER_GROUPS          comma-separated group aliases (optional)
//   APK_PATH                        path to the .apk to upload
//   RELEASE_NOTES                   release notes text (optional)
//
// Prints progress; never prints the key or the access token. Exits non-zero on
// failure so the workflow step fails loudly.

import https from "node:https";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://firebaseappdistribution.googleapis.com";
const fail = (msg) => {
  console.error(`::error::Firebase App Distribution: ${msg}`);
  process.exit(1);
};

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      { method, headers },
      (res) => {
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
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Mint an OAuth access token from the service-account key (RS256 JWT bearer).
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claim = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const appId = process.env.FIREBASE_APP_ID;
  const apkPath = process.env.APK_PATH;
  const groups = (process.env.FIREBASE_TESTER_GROUPS || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  const releaseNotes = process.env.RELEASE_NOTES || "";

  if (!keyPath || !appId || !apkPath) {
    fail("missing GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_APP_ID, or APK_PATH");
  }

  const sa = JSON.parse(readFileSync(keyPath, "utf8"));
  // App id looks like `1:<projectNumber>:android:<hash>`.
  const projectNumber = appId.split(":")[1];
  if (!projectNumber) fail(`could not parse project number from app id "${appId}"`);
  const appName = `projects/${projectNumber}/apps/${appId}`;

  const token = await getAccessToken(sa);
  console.log(`Authenticated as ${sa.client_email}; uploading to ${appName}`);

  // 1) Upload the binary — returns a long-running operation.
  const apk = readFileSync(apkPath);
  const up = await request(
    "POST",
    `${API}/upload/v1/${appName}/releases:upload`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-File-Name": apkPath.split("/").pop(),
        "Content-Length": apk.length,
      },
      body: apk,
    },
  );
  if (up.status !== 200 || !up.json?.name) {
    fail(`upload failed (status ${up.status}): ${up.text?.slice(0, 300)}`);
  }
  const opName = up.json.name;
  console.log(`Uploaded; processing operation ${opName}`);

  // 2) Poll the operation until the release is processed (~up to 5 min).
  let releaseName;
  for (let i = 0; i < 30; i++) {
    await sleep(i === 0 ? 2000 : 10000);
    const op = await request("GET", `${API}/v1/${opName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (op.status !== 200) {
      fail(`operation poll failed (status ${op.status}): ${op.text?.slice(0, 300)}`);
    }
    if (op.json.error) {
      fail(`processing failed: ${op.json.error.message || JSON.stringify(op.json.error)}`);
    }
    if (op.json.done) {
      releaseName = op.json.response?.release?.name;
      break;
    }
  }
  if (!releaseName) fail("release did not finish processing in time");
  console.log(`Processed release ${releaseName}`);

  // 3) Attach release notes (best-effort — don't fail the build over notes).
  if (releaseNotes) {
    const pn = await request(
      "PATCH",
      `${API}/v1/${releaseName}?updateMask=releaseNotes.text`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ releaseNotes: { text: releaseNotes } }),
      },
    );
    if (pn.status !== 200) {
      console.log(`Warning: could not set release notes (status ${pn.status})`);
    }
  }

  // 4) Distribute to tester groups.
  if (groups.length) {
    const dist = await request("POST", `${API}/v1/${releaseName}:distribute`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groupAliases: groups }),
    });
    if (dist.status !== 200) {
      fail(`distribute to [${groups.join(", ")}] failed (status ${dist.status}): ${dist.text?.slice(0, 300)}`);
    }
    console.log(`Distributed to groups: ${groups.join(", ")}`);
  } else {
    console.log("No tester groups configured; release uploaded but not distributed.");
  }

  // Expose the release name to downstream workflow steps (e.g. App Testing Agent).
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ghOutput, `release_name=${releaseName}\n`);
  }

  console.log("Firebase App Distribution upload complete.");
}

main().catch((e) => fail(e.message || String(e)));
