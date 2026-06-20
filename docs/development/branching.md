# Branch strategy

Stash uses **trunk-based development with release branches** — the common
modern model for an app that ships versioned releases and occasionally patches
an older one. It keeps the bulk of the work on one line (`main`) and spins up a
maintenance branch only when a shipped version needs fixes.

## The branches

| Branch          | Role                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `main`          | **Trunk** — the active development line, heading toward the next MINOR (now `0.2.0`).  |
| `release/X.Y.x` | **Maintenance line** for a shipped MINOR. `release/0.1.x` carries `0.1.*` patches.     |
| `claude/*`      | Short-lived working branches (one per change). Based off whichever target it lands on. |

A `release/X.Y.x` branch is cut from `main` at the point that MINOR shipped, and
lives as long as that series is supported. `release/0.1.x` was cut from the
`v0.1.8` commit.

## Where to base your work

Pick the base by **which release the change is for**, then open a PR back into
that same branch:

- **New 0.2.x feature / anything for the next release** → branch from `main`,
  PR into `main`.
- **Bug fix for the shipped 0.1.x line** → branch from `release/0.1.x`, PR into
  `release/0.1.x`.

```
main ──●(v0.1.8)──●──────●──────●  → v0.2.0        (trunk: 0.2.x features land here)
        \
         release/0.1.x ──●──────●  → v0.1.9, v0.1.10   (0.1.x bug fixes)
                          └─ cherry-pick each fix ↑ up into main
```

## Forward-porting fixes (the one rule that matters)

A bug fixed on `release/0.1.x` is **not** automatically in `main`. Every fix
that still applies to the next release must be **cherry-picked forward** into
`main`, or `0.2.0` will ship a regression of a bug you already fixed.

```bash
# after a fix lands on release/0.1.x (commit <sha>):
git checkout main
git cherry-pick <sha>      # resolve any conflicts, keep the same intent
```

If a fix is genuinely 0.1.x-only (e.g. it touches code `main` already replaced),
say so in the PR description so it's clear the omission is intentional.

> Direction: fixes flow **oldest → newest** (`release/0.1.x` → `main`), never the
> reverse. Don't merge `main` into a release branch — that would drag unreleased
> features into a patch.

## Releasing from either line

Releases are **tag-driven** and a tag can point at any branch (the
`android-apk.yml` and `sentry-release.yml` workflows trigger on `v*` tags from
any ref), so the release line isn't tied to `main`:

- **0.1.x patch** → tag `v0.1.9` on `release/0.1.x` (notes in
  `docs/release-notes/v0.1.9.md`).
- **0.2.0 feature release** → tag `v0.2.0` on `main`.

See [`releasing.md`](./releasing.md) for the versioning rules (PATCH vs MINOR)
and the build/publish mechanics.

## When 0.2.0 ships

Once `v0.2.0` is tagged from `main`, `main` simply continues toward `0.3.0`.
If `0.2.x` later needs a patch, cut `release/0.2.x` from the `v0.2.0` commit and
repeat the same flow. Retire `release/0.1.x` when the `0.1` series is no longer
supported.
