# `feedback-bridge` edge function

Forwards in-app feedback reports to an external reporting system (Sentry by
default). The mobile app only ever writes a row to `feedback_reports`; a
Supabase **database webhook** fires this function on insert, and it delivers the
report to the third party server-side — so the DSN/secret and any further
redaction live off-device.

```
INSERT into public.feedback_reports
  → webhook POST /functions/v1/feedback-bridge
      { type: "INSERT", record: { ...feedback_reports row } }
  → SentrySink.deliver(report)  → Sentry envelope API
```

## The swappable seam

The destination is chosen at exactly one line in `index.ts`:

```ts
const sink: ReportSink | null = SENTRY_DSN
  ? new SentrySink(SENTRY_DSN, { release: APP_RELEASE })
  : null;
```

To send reports somewhere else (Linear, Slack, GitHub Issues, …), add a module
implementing `ReportSink` and point that line at it. The database, the webhook,
and the app all stay unchanged. This mirrors the `EnrichmentProvider` seam in
`ai-enrich`.

## Files

| File                  | Role                                                              |
| --------------------- | ---------------------------------------------------------------- |
| `sink.ts`             | `ReportSink` interface + `FeedbackReport` type + webhook parsing — the swappable seam |
| `sentry-sink.ts`      | `SentrySink`: builds a Sentry event/envelope; HTTP transport is injectable |
| `index.ts`            | Deno HTTP shell: verify → parse webhook → deliver via the sink   |
| `sentry-sink.test.ts` | Node unit tests (run by `pnpm test`)                             |

## Privacy

`feedback_reports.context` is redacted client-side (see the mobile app's
`buildDiagnosticsContext`): it never contains user-authored bookmark content
(URLs, titles, notes). The `message` is the reporter's own words and is the
feedback itself. The sink forwards context verbatim under `extra.diagnostics`.
Sentry is a third-party data processor; self-hosting is an option if data must
stay on your infra.

## CI coverage

`sentry-sink.test.ts` runs in the existing CI job via `pnpm test`
(`supabase/functions/**/*.test.ts`). The Sentry HTTP transport is **injected**,
so tests assert the exact envelope/headers built from a report without ever
hitting Sentry's network — no DSN or secret is needed in CI, and PR checks never
depend on a third party being reachable. Live delivery only happens in the
deployed edge function, which uses the default `fetch` transport.

## Environment

| Variable                 | Required | Purpose                                                        |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `SENTRY_DSN`             | for prod | Sentry project DSN. Unset ⇒ the function is a no-op (200 skip). |
| `FEEDBACK_RELEASE`       | optional | Release tag attached to events; defaults to the report's `app_version`. |
| `FEEDBACK_BRIDGE_SECRET` | optional | Shared secret; when set, the webhook must send it as the `x-feedback-bridge-secret` header. |

Set them with:

```bash
supabase secrets set SENTRY_DSN="https://<key>@<host>/<project>"
supabase secrets set FEEDBACK_BRIDGE_SECRET="<random-string>"
```

## Wiring the database webhook

The INSERT → function trigger ships as a migration
(`supabase/migrations/20260626000000_feedback_bridge_webhook.sql`). It uses
`pg_net` and reads its URL + shared secret from **Vault**, mirroring the
`dispatch_ai_enrichment` trigger — so no secret is baked into the repo and the
trigger never holds the writer's transaction open on the network.

The migration creates everything except the secrets, which the operator sets
out-of-band (so they stay off-repo). Set **both** the Vault secrets the trigger
reads and the matching edge-function env vars:

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/feedback-bridge', 'feedback_bridge_url');
select vault.create_secret('<random-shared-secret>', 'feedback_bridge_secret');
```

```bash
supabase secrets set SENTRY_DSN="https://<key>@<host>/<project>"
supabase secrets set FEEDBACK_BRIDGE_SECRET="<same-random-shared-secret>"
```

The `feedback_bridge_secret` Vault value (sent as the `x-feedback-bridge-secret`
header) must equal the function's `FEEDBACK_BRIDGE_SECRET` env, or the function
rejects the webhook (401). Until `feedback_bridge_url` is set the trigger is a
no-op; reports are always persisted regardless — forwarding is best-effort.

> Note: this project never had the dashboard-managed Database Webhooks feature
> (`supabase_functions` schema) enabled, so the trigger calls `net.http_post`
> directly rather than `supabase_functions.http_request`.

## Local development

```bash
supabase functions serve feedback-bridge
```
