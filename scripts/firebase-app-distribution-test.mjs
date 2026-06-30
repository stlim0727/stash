// Trigger the Firebase App Distribution App Testing Agent for an already-uploaded
// release, then (optionally) poll until all device executions finish and print
// a per-device summary.
//
// The agent is powered by Gemini in Firebase and runs test cases defined in the
// App Distribution console (natural-language goals). Test case IDs come from the
// "Test Cases" page in the Firebase console.
//
// Inputs (env):
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account JSON key
//   FIREBASE_APP_ID                 e.g. 1:1234567890:android:abcdef
//   RELEASE_NAME                    full resource name from the distribute step
//                                   e.g. projects/123/apps/1:123:android:abc/releases/r0abc
//   TEST_CASES                      comma-separated test case IDs (from the console)
//                                   e.g. "load-app,complete-onboarding"
//   TEST_DEVICES                    semicolon-separated device specs
//                                   e.g. "model=shiba,version=34,locale=en,orientation=portrait"
//   TEST_USERNAME                   (optional) auto-login username
//   TEST_PASSWORD                   (optional) auto-login password
//   TEST_USERNAME_RESOURCE          (optional) Android resource name for the username field
//   TEST_PASSWORD_RESOURCE          (optional) Android resource name for the password field
//   TEST_NON_BLOCKING               (optional) "true" to exit without waiting for results

import https from "node:https";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://firebaseappdistribution.googleapis.com";
const fail = (msg) => {
  console.error(`::error::Firebase App Testing Agent: ${msg}`);
  process.exit(1);
};

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
    fail(
      `service-account private_key is not a usable PEM (${e.code || e.message})`,
    );
  }
  const body =
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
    assertion;
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

// Parse "model=shiba,version=34,locale=en,orientation=portrait" → object.
function parseDeviceSpec(spec) {
  const device = {};
  for (const part of spec.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) fail(`invalid device spec segment "${part}" (expected key=value)`);
    device[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!device.model) fail(`device spec missing "model": "${spec}"`);
  if (!device.version) fail(`device spec missing "version": "${spec}"`);
  return device;
}

const STATE_TERMINAL = new Set(["PASSED", "FAILED", "INCONCLUSIVE", "SKIPPED"]);

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const appId = process.env.FIREBASE_APP_ID;
  const releaseName = process.env.RELEASE_NAME;
  const testCasesRaw = process.env.TEST_CASES || "";
  const testDevicesRaw = process.env.TEST_DEVICES || "";
  const nonBlocking = process.env.TEST_NON_BLOCKING === "true";
  const username = process.env.TEST_USERNAME || "";
  const password = process.env.TEST_PASSWORD || "";
  const usernameResource = process.env.TEST_USERNAME_RESOURCE || "";
  const passwordResource = process.env.TEST_PASSWORD_RESOURCE || "";

  if (!keyPath || !appId || !releaseName) {
    fail(
      "missing GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_APP_ID, or RELEASE_NAME",
    );
  }
  if (!testCasesRaw) fail("TEST_CASES is required (comma-separated IDs from the Firebase console)");
  if (!testDevicesRaw) fail("TEST_DEVICES is required (semicolon-separated device specs)");

  const sa = JSON.parse(readFileSync(keyPath, "utf8"));
  const projectNumber = appId.split(":")[1];
  if (!projectNumber) fail(`could not parse project number from app id "${appId}"`);
  const appName = `projects/${projectNumber}/apps/${appId}`;

  const testCaseIds = testCasesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const deviceSpecs = testDevicesRaw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!testCaseIds.length) fail("TEST_CASES produced no valid IDs after parsing");
  if (!deviceSpecs.length) fail("TEST_DEVICES produced no valid specs after parsing");

  const token = await getAccessToken(sa);
  console.log(
    `Authenticated as ${sa.client_email}; launching App Testing Agent on ${releaseName}`,
  );

  const body = {
    testCases: testCaseIds.map((id) => ({
      testCase: `${appName}/testCases/${id}`,
    })),
    deviceExecutions: deviceSpecs.map((spec) => ({
      device: parseDeviceSpec(spec),
    })),
  };
  if (username && password) {
    body.loginCredential = { username, password };
    if (usernameResource || passwordResource) {
      body.loginCredential.fieldHints = {};
      if (usernameResource)
        body.loginCredential.fieldHints.usernameResourceName = usernameResource;
      if (passwordResource)
        body.loginCredential.fieldHints.passwordResourceName = passwordResource;
    }
  }

  const create = await request(
    "POST",
    `${API}/v1/${releaseName}/tests`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (create.status !== 200 || !create.json?.name) {
    fail(
      `failed to create test run (status ${create.status}): ${create.text?.slice(0, 300)}`,
    );
  }
  const testName = create.json.name;
  console.log(`App Testing Agent started: ${testName}`);
  console.log(`  Test cases : ${testCaseIds.join(", ")}`);
  console.log(`  Devices    : ${deviceSpecs.join(" | ")}`);

  // Expose the test resource name to downstream steps.
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ghOutput, `test_name=${testName}\n`);
  }

  if (nonBlocking) {
    console.log(
      "TEST_NON_BLOCKING=true — not waiting for results. " +
        "Check the Firebase console (App Distribution → Test Cases) for outcome.",
    );
    return;
  }

  // Poll until all executions reach a terminal state (max ~30 min).
  console.log("Waiting for test results (this may take 10–30 minutes)…");
  let lastState = "";
  for (let i = 0; i < 90; i++) {
    await sleep(i < 3 ? 10_000 : 20_000);
    const poll = await request("GET", `${API}/v1/${testName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.status !== 200) {
      console.log(
        `Warning: poll failed (status ${poll.status}) — retrying…`,
      );
      continue;
    }
    const state = poll.json.state || "UNKNOWN";
    if (state !== lastState) {
      console.log(`  State: ${state}`);
      lastState = state;
    }
    if (STATE_TERMINAL.has(state)) {
      printResults(poll.json);
      if (state !== "PASSED") {
        fail(`App Testing Agent finished with state: ${state}`);
      }
      console.log("App Testing Agent: all test cases PASSED.");
      return;
    }
  }
  // Timed out — non-fatal so the build still publishes, but flag it.
  console.log(
    "::warning::App Testing Agent did not finish within the polling window. " +
      "Check the Firebase console for results.",
  );
}

function printResults(test) {
  const executions = test.deviceExecutions || [];
  for (const exec of executions) {
    const dev = exec.device
      ? `${exec.device.model}@${exec.device.version}`
      : "unknown-device";
    console.log(`\n[${dev}] ${exec.state || "?"}`);
    for (const r of exec.testCaseResults || []) {
      const caseId = (r.testCase || "").split("/").pop();
      const icon = r.state === "PASSED" ? "✓" : "✗";
      const reason = r.failedReason ? ` — ${r.failedReason}` : "";
      console.log(`  ${icon} ${caseId}: ${r.state || "?"}${reason}`);
    }
  }
}

main().catch((e) => fail(e.message || String(e)));
