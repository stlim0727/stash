// Trigger the Firebase App Distribution App Testing Agent for an already-uploaded
// release, then (optionally) poll until all device executions finish and print
// a per-device summary.
//
// The agent is powered by Gemini in Firebase and runs test cases defined in the
// App Distribution console (natural-language goals). Test case IDs come from the
// "Test Cases" page in the Firebase console.
//
// The App Testing Agent lives on the v1alpha API. Each release test accepts a
// single testCase resource name, so this script creates one release test per
// test case ID and polls them all to completion.
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

// The App Testing Agent is on the v1alpha surface (not v1).
// Ref: firebase-tools src/appdistribution/client.ts — appDistroV1AlphaClient
const API = "https://firebaseappdistribution.googleapis.com";
const API_VERSION = "v1alpha";

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
    if (eq === -1)
      fail(`invalid device spec segment "${part}" (expected key=value)`);
    device[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!device.model) fail(`device spec missing "model": "${spec}"`);
  if (!device.version) fail(`device spec missing "version": "${spec}"`);
  return device;
}

// The v1alpha ReleaseTest has no top-level state field. Completion is determined
// by inspecting each deviceExecution's state individually.
// Ref: firebase-tools src/appdistribution/distribution.ts — awaitTestResults
function allExecutionsTerminal(releaseTest) {
  const executions = releaseTest.deviceExecutions || [];
  if (!executions.length) return false;
  return executions.every(
    (e) => e.state === "PASSED" || e.state === "FAILED" || e.state === "INCONCLUSIVE",
  );
}

function anyExecutionFailed(releaseTest) {
  return (releaseTest.deviceExecutions || []).some(
    (e) => e.state === "FAILED" || e.state === "INCONCLUSIVE",
  );
}

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
  if (!testCasesRaw)
    fail(
      "TEST_CASES is required (comma-separated IDs from the Firebase console)",
    );
  if (!testDevicesRaw)
    fail("TEST_DEVICES is required (semicolon-separated device specs)");

  const sa = JSON.parse(readFileSync(keyPath, "utf8"));
  const projectNumber = appId.split(":")[1];
  if (!projectNumber)
    fail(`could not parse project number from app id "${appId}"`);
  const appName = `projects/${projectNumber}/apps/${appId}`;

  const testCaseIds = testCasesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const deviceSpecs = testDevicesRaw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!testCaseIds.length)
    fail("TEST_CASES produced no valid IDs after parsing");
  if (!deviceSpecs.length)
    fail("TEST_DEVICES produced no valid specs after parsing");

  const token = await getAccessToken(sa);
  console.log(
    `Authenticated as ${sa.client_email}; launching App Testing Agent on ${releaseName}`,
  );

  const deviceExecutions = deviceSpecs.map((spec) => ({
    device: parseDeviceSpec(spec),
  }));

  const loginCredential =
    username && password
      ? {
          username,
          password,
          ...(usernameResource || passwordResource
            ? {
                fieldHints: {
                  ...(usernameResource
                    ? { usernameResourceName: usernameResource }
                    : {}),
                  ...(passwordResource
                    ? { passwordResourceName: passwordResource }
                    : {}),
                },
              }
            : {}),
        }
      : undefined;

  // v1alpha accepts one testCase per release test — create one per test case ID.
  const testNames = [];
  for (const id of testCaseIds) {
    const testCaseResource = `${appName}/testCases/${id}`;
    const body = {
      deviceExecutions,
      testCase: testCaseResource,
      ...(loginCredential ? { loginCredential } : {}),
    };
    const res = await request(
      "POST",
      `${API}/${API_VERSION}/${releaseName}/tests`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (res.status !== 200 || !res.json?.name) {
      fail(
        `failed to create test run for "${id}" (status ${res.status}): ${res.text?.slice(0, 300)}`,
      );
    }
    testNames.push(res.json.name);
    console.log(`  Started: ${res.json.name} (testCase: ${id})`);
  }

  console.log(
    `App Testing Agent: ${testNames.length} test run(s) started on ${deviceSpecs.length} device(s).`,
  );

  // Expose test names to downstream steps.
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ghOutput, `test_names=${testNames.join(",")}\n`);
  }

  if (nonBlocking) {
    console.log(
      "TEST_NON_BLOCKING=true — not waiting for results. " +
        "Check the Firebase console (App Distribution → Test Cases) for outcomes.",
    );
    return;
  }

  // Poll until every release test reaches a terminal state on all device executions.
  // Max ~20 min (40 attempts × 30 s). Mirrors firebase-tools awaitTestResults.
  console.log("Waiting for test results (may take 10–20 minutes)…");
  const pending = new Map(testNames.map((n) => [n, null]));
  const failures = [];

  for (let i = 0; i < 40 && pending.size > 0; i++) {
    await sleep(30_000);
    for (const name of [...pending.keys()]) {
      const poll = await request("GET", `${API}/${API_VERSION}/${name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (poll.status !== 200) {
        console.log(`  Warning: poll failed for ${name} (status ${poll.status}) — retrying`);
        continue;
      }
      if (allExecutionsTerminal(poll.json)) {
        pending.delete(name);
        printTestResult(poll.json);
        if (anyExecutionFailed(poll.json)) {
          failures.push(name);
        }
      }
    }
    if (pending.size > 0) {
      console.log(`  ${pending.size} test run(s) still in progress…`);
    }
  }

  if (pending.size > 0) {
    console.log(
      `::warning::App Testing Agent: ${pending.size} test run(s) did not finish within the polling window. ` +
        "Check the Firebase console for results.",
    );
  }

  if (failures.length) {
    fail(`${failures.length} test run(s) had FAILED or INCONCLUSIVE executions.`);
  }
  console.log("App Testing Agent: all executions PASSED.");
}

function printTestResult(releaseTest) {
  const caseId = (releaseTest.testCase || releaseTest.name || "?")
    .split("/")
    .pop();
  console.log(`\n[testCase: ${caseId}]`);
  for (const exec of releaseTest.deviceExecutions || []) {
    const dev = exec.device
      ? `${exec.device.model}@${exec.device.version}`
      : "unknown-device";
    const icon = exec.state === "PASSED" ? "✓" : "✗";
    const reason =
      exec.failedReason || exec.inconclusiveReason
        ? ` — ${exec.failedReason || exec.inconclusiveReason}`
        : "";
    console.log(`  ${icon} ${dev}: ${exec.state || "?"}${reason}`);
  }
}

main().catch((e) => fail(e.message || String(e)));
