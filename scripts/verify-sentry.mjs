/**
 * End-to-end smoke test for crash & error monitoring: sends a synthetic event
 * straight to the configured Sentry DSN and asserts the ingest API accepted it.
 * This proves the DSN → project pipeline is live; it does not exercise the app's
 * console.error/recordLog bridge (that is covered by the unit tests, and only
 * runs joined together on a real device build).
 *
 * Usage:
 *   EXPO_PUBLIC_SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<id> \
 *   pnpm verify:sentry
 *
 * The event is tagged environment="verify" / logger="stash-verify" with a unique
 * `verify_marker`, so it is easy to find (and ignore) separately from real
 * issues. Exits non-zero on any failure.
 */
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);

const { getSentryConfigState, describeSentryConfig, parseSentryDsn } = await import(
  '../apps/mobile/src/observability/sentry-config.ts'
);

console.log('Sentry end-to-end verification\n');

const state = getSentryConfigState();
if (state.status !== 'enabled') {
  console.error(`  ✗ configuration — ${describeSentryConfig(state)}`);
  console.error('    Set EXPO_PUBLIC_SENTRY_DSN to your project DSN and re-run.');
  process.exit(1);
}

const parts = parseSentryDsn(state.config.dsn);
if (!parts) {
  console.error('  ✗ configuration — EXPO_PUBLIC_SENTRY_DSN is not a valid DSN');
  process.exit(1);
}
console.log(`  ✓ configuration — project ${parts.projectId} on ${parts.host}`);

const marker = `stash-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
const event = {
  event_id: randomUUID().replace(/-/g, ''),
  timestamp: new Date().toISOString(),
  platform: 'javascript',
  level: 'error',
  logger: 'stash-verify',
  environment: 'verify',
  message: { formatted: `${marker} verify:sentry pipeline check` },
  tags: { verify_marker: marker },
};

let response;
try {
  response = await fetch(parts.storeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parts.publicKey}, sentry_client=stash-verify/1.0`,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(20_000),
  });
} catch (error) {
  console.error('  ✗ ingest — request failed (network/egress?)');
  console.error(`    ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const body = await response.text();
if (!response.ok) {
  console.error(`  ✗ ingest — HTTP ${response.status}`);
  console.error(`    ${body.slice(0, 300)}`);
  process.exit(1);
}

let id;
try {
  id = JSON.parse(body).id;
} catch {
  // fall through to the missing-id check
}
if (!id) {
  console.error(`  ✗ ingest — accepted but no event id returned: ${body.slice(0, 200)}`);
  process.exit(1);
}

console.log(`  ✓ ingest — Sentry accepted event ${id}`);
console.log(`\nDone. Find it in Sentry by searching: verify_marker:${marker}`);
console.log('(The event is tagged environment:verify — resolve/ignore it so it stays out of real issues.)');
