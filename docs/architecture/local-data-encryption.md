# Local data encryption

Status: **token storage shipped; local-DB encryption proposed (not yet built).**

This note records where Stash stands on encrypting user data on-device and the
plan for the remaining gap. It exists because the question "do we need
encryption to commercialize?" came up, and the answer is "only on-device, and in
two specific places."

## What we protect today

| Surface | Mechanism | App-level encryption |
| --- | --- | --- |
| In transit | HTTPS/TLS to Supabase | n/a (transport) |
| Backend at rest | Supabase/AWS AES-256 disk + backups | none needed (platform) |
| Backend access | owner-scoped RLS (`auth.uid() = user_id`) | n/a (access control) |
| **Auth tokens on device** | **`expo-secure-store` (Keychain/Keystore)** | **yes — shipped** |
| **Local bookmark DB on device** | plain `expo-sqlite` (`stash.db`) | **no — this doc** |

Backend column-level encryption is deliberately **out of scope**: the platform
already encrypts disks and backups, `pgcrypto` column encryption would break
search/indexing, and the `ai-enrich` edge function needs plaintext to work.
End-to-end encryption is a possible future product differentiator, not a
commercialization baseline, and it conflicts with server-side enrichment/search.

## Shipped: auth tokens in secure storage

The Supabase session — including the long-lived `refresh_token` — used to be
written as JSON into a plain (unencrypted) SQLite file (`stash-auth.db`),
readable from a device backup or a rooted/jailbroken device. It now lives in
OS-backed secure storage:

- `secure-session-core.ts` — platform-free core (chunking, validation, legacy
  migration), exhaustively unit-tested with a fake backend.
- `session-storage.native.ts` — `expo-secure-store` backend
  (`keychainAccessible: AFTER_FIRST_UNLOCK` so background token refresh still
  works), plus a read-only adapter over the legacy `stash-auth.db` for one-time
  migration.
- `session-storage.ts` (web) — same core over localStorage/in-memory (web has no
  Keychain; it is a dev/SSR target, not the security-sensitive surface).

Two non-obvious details the core handles:

1. **Size limit.** `expo-secure-store` only reliably stores ~2 KB per value on
   Android; a session with both tokens plus OAuth `user_metadata` can exceed
   that, and a silent write failure would mint a fresh anonymous user next launch
   and **orphan the original user's bookmarks**. The core splits the payload into
   byte-bounded chunks and **double-buffers** overwrites — the new session is
   written under an inactive generation and a single pointer key is flipped to
   commit, so an interrupted/failed overwrite leaves the previous session fully
   readable rather than corrupting the live one.
2. **Migration.** Existing installs already hold a session in the plaintext
   store. First read after upgrade carries it into secure storage and wipes the
   plaintext copy, so nobody is signed out by the switch.

This was prioritized first because it is the highest-value, lowest-cost gap and
adds **no debugging friction** — Keychain/Keystore reads behave normally in the
simulator and dev builds.

## Proposed: encrypted local bookmark DB

`repository.native.ts` stores the full bookmark records, the pending-sync queue
(which carries complete bookmark payloads), tags, and enrichments as plaintext
JSON in `stash.db`. A user's saved URLs plus **private notes** are personal data;
a device backup or rooted device exposes them in cleartext. For a paid product
holding "private notes", encrypting this at rest is expected.

### The debugging trade-off (why this is gated, not unconditional)

Encrypting the DB is the one change here that *hurts* day-to-day debugging:

- External tooling (DB Browser, Flipper, `adb pull` + `sqlite3`) can no longer
  open the file, because the key lives in the Keystore.
- `expo-sqlite` has no SQLCipher support, so adopting encryption means swapping
  the SQLite binding (e.g. `op-sqlite` built with SQLCipher) — a change to the
  repository's core dependency, with migration risk.
- "Pull the DB and inspect it" stops being a debugging option, pushing us toward
  logging/repro instead.

So the plan **gates encryption on build type** rather than turning it on
everywhere:

```
Production build  → encryption ON, key from expo-secure-store (Keystore/Keychain)
Dev build (__DEV__) → encryption OFF (or a fixed, well-known dev key)
```

This keeps the inspect-the-DB workflow during development while shipping an
encrypted store to users. A debug-only plaintext export helper can cover the rare
case of inspecting production-shaped data.

### Sketch

1. Add an encrypted SQLite binding (SQLCipher via `op-sqlite` or equivalent);
   keep the `BookmarkRepository` interface and `SCHEMA_SQL` unchanged.
2. On first launch, generate a random 256-bit DB key and store it in
   `expo-secure-store` (reuse the secure backend from the token work). In
   `__DEV__`, skip the key / open unencrypted.
3. Open with `PRAGMA key` from the stored key before any statement runs.
4. Migration for existing installs: open the current plaintext `stash.db`, copy
   rows into a new encrypted DB (`sqlcipher_export`-style), then atomically swap
   and delete the plaintext file. Like the token migration, this must be
   idempotent and best-effort so a failure never blocks capture.
5. Tests: the encryption itself can't be exercised by the Node logic lane, but
   the **migration/key-management logic should be factored into a pure,
   backend-injected core and unit-tested** the same way `secure-session-core.ts`
   is — fake key store, fake row source, assert round-trip and idempotency.

### Open questions

- Binding choice (`op-sqlite` + SQLCipher vs encrypting JSON blobs in place
  while keeping `expo-sqlite`). The latter avoids swapping the binding but loses
  the ability to query encrypted columns — acceptable since we already store full
  records as opaque JSON blobs and query mostly by id/created_at.
- Key rotation / loss handling (Keystore wipe on biometric reset → DB becomes
  unreadable; need a graceful "re-sync from server" recovery, since the server
  copy is the source of truth for synced bookmarks).
- Performance impact of SQLCipher on cold-start load and the sync drain.

Until this ships, the local bookmark DB relies on OS full-disk encryption (iOS
Data Protection / Android FBE) only — adequate for a beta, below the bar for a
commercial release holding private notes.
