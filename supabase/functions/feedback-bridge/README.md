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

Either configure a **Database Webhook** in the Supabase dashboard
(Database → Webhooks) on `public.feedback_reports`, event `INSERT`, pointing at
`https://<project-ref>.supabase.co/functions/v1/feedback-bridge`, adding the
`x-feedback-bridge-secret` header if you set `FEEDBACK_BRIDGE_SECRET` — or
create the trigger in SQL:

```sql
create trigger on_feedback_report_created
  after insert on public.feedback_reports
  for each row execute function supabase_functions.http_request(
    'https://<project-ref>.supabase.co/functions/v1/feedback-bridge',
    'POST',
    '{"Content-Type":"application/json","x-feedback-bridge-secret":"<secret>"}',
    '{}',
    '5000'
  );
```

## Local development

```bash
supabase functions serve feedback-bridge
```
