# Working rules

Keepory is the Expo bookmark app historically named Stash. Start with
`AGENTS.md` and its task map; source and executable configuration win over dated
prose. Load subsystem references only for the behavior you are changing.

- State assumptions and clarify material ambiguity; progress on independent work.
- Keep implementation simple and scoped to the request. No speculative features,
  abstractions, dependencies, or adjacent cleanup.
- Preserve user edits. Match local conventions and remove only unused code that
  your change introduced.
- Define observable success criteria. Establish relevant test baselines, then
  verify behavior after refactoring. Confirm a failure on the base before calling
  it pre-existing; an untouched test may still exercise your changed behavior.
- Diagnose recurrent failures from evidence before applying another guessed fix.
  Enumerate adversarial cases for gates and use sequence tests for state machines.
- Prefer configured MCP tools over applicable skills over scripts/CLI.
- Use `rg` for bounded searches, exclude generated/dependency directories, and
  read relevant spans rather than entire large files.
- Preserve local-first capture, durable queue/identity changes, account isolation,
  and user/generated provenance. Read `AGENTS.md` and the subsystem reference
  before modifying storage, sync, auth, or capture.
- Run root `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm test:components --runInBand` before publishing code changes. Do not run
  `expo lint` inside the mobile app or introduce its config/lockfile churn.
- Use the documented trunk/release branch strategy; shipped fixes go to their
  release line and forward to main. An inseparable multi-step feature develops
  on one integration branch and merges as one reviewed unit.
- Follow the PR/review/merge rules linked from `AGENTS.md`, including the bot
  review window and migration deploy-order gate. Skills remain mirrored under
  `.claude/skills` and `.codex/skills`.
- Identify manual GitHub comments as the actual coding agent and AI assistant.
  A `STASH-N` title alone does not resolve Sentry; follow the documented flow.
- Native SQLite/share intake requires standalone device testing; Expo Go and
  pure logic tests do not establish device acceptance.

The [detailed working rules](docs/development/agent-working-rules.md) preserve
rationale, examples, release/CI procedures, and command details. The
[agent reference](docs/development/agent-reference.md) retains subsystem
invariants and known traps. Read the applicable section when touching that area.
