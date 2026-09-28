# Reporting and request handling traps

Historical implementation notes retained from PR #797.

- **Client timeout vs Edge Function timeout (`StashSupabaseClient.request`)**:
  A blanket client-side request timeout (e.g. 15s) must not abort operations
  that call long-running edge functions. Specifically, `ai-enrich`'s Gemini
  provider waits 15s before catching its timeout and writing an intended
  heuristic fallback (`supabase/functions/ai-enrich/gemini-provider.ts`). If the
  client timer also fires at 15s, it aborts ahead of receiving that fallback
  and triggers unnecessary client failure/retry paths. Keep timeouts
  configurable or extended for edge function routes.
- **Promise chain serialization with `Promise.race`**: Constructing a bounded task
  like `Promise.race([task(), timeout])` starts `task()` immediately. When
  chaining onto a serialized queue (`promise.then(() => ...)`), invoking `task()`
  before or outside the `.then()` callback executes network work in parallel
  rather than sequentially, allowing older in-flight requests to finish after
  newer ones. Always defer task invocation inside the `.then(() => ...)` callback.
- **Supabase credentials & direct querying fallback**: `SUPABASE_SECRET_KEY` in
  `.env` / `.env.local` uses the `sb_secret_...` format (a service-role secret
  API key), not a Management API PAT (`sbp_...`). When Supabase MCP is not
  configured, query `https://<ref>.supabase.co/rest/v1/` and `/auth/v1/admin/`
  directly with `apikey: <key>` and `Authorization: Bearer <key>`. Do not send it
  to `https://api.supabase.com/v1/` (fails with `401: JWT could not be decoded`).
- **Google Play Pre-Launch Report bursts in `auth.users`**: Uploading an APK/AAB
  triggers Google Play Console's automated Robo test crawler across ~10–15
  devices in 1–2 minutes. Because Keepory is anonymous-first and stamps
  metadata on launch, this appears as an immediate cluster of anonymous Android
  users with 0 bookmarks and `app_version` matching the release. Audits of
  install base or user growth must filter out these bursts to avoid overcounting
  organic adoption.


The user summary now labels retained plus reaped identities as unfiltered accounts,
not installs or organic sessions. Historical cleanup rows cannot classify automation.
Use `node --test scripts/user-bookmark-summary.test.mjs` for offline report fixtures.
