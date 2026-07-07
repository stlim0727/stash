# tag-merge eval

Grades a candidate model's **tag consolidation** (the `ai-organize` / "Consolidate
tags" job — see `docs/design/library-organizing.md` §8.4) against a
**human-approved ground truth**, so the production model choice is measured, not
guessed.

## Why this exists

The live Phase 1 run on user A (totohero) produced a high-quality merge — but by a
**frontier model reasoning directly**, not the registered Gemini. Before shipping
`ai-organize` we need to know which model actually clears the bar. The whole
feature lives or dies on **merge precision on near-neighbors** (접영 butterfly vs
배영 backstroke, 김치찌개 vs 된장찌개): over-merging destroys a user's taxonomy.

## The ground truth

`fixtures/totohero-ground-truth.json` — from the applied Phase 1 run:

- **`groups`** — the 18 merge groups actually applied (must-MERGE equivalence
  classes). Every tag not in a group is its own singleton.
- **`hard_negatives`** — pairs we deliberately kept separate (must-NOT-merge,
  **zero tolerance**).

`fixtures/totohero-vocab.json` — the frozen 296-tag vocabulary (name +
usage_count + source), exactly what `ai-organize` would receive (no bookmark
content). Scoring is by tag **name** (unique per user); production keys by id.

## Metrics & gate

- **Merge precision** — of all pairs the model merged, fraction the ground truth
  also merges. **Gated: ≥ 0.95.**
- **Forbidden merges** — hard-negative pairs the model merged. **Gated: 0, across
  every run.**
- **Merge recall** — of ground-truth merges, fraction the model found.
  *Informational* — precision ≫ recall (a missed merge is cheap; a wrong one is
  destructive).
- **Restraint** — tags left unmerged vs the truth's 214 (over-merge shows here).

A model is **shippable** only if it passes the gate on **N ≥ 5** runs (temp 0.1 is
still stochastic; a model that trips a hard negative 1-in-5 is unshippable).

## Run

```sh
export GEMINI_API_KEY=...        # and/or ANTHROPIC_API_KEY=...

node scripts/tag-merge-eval/run.mjs --provider gemini --model gemini-2.5-flash-lite --runs 5
node scripts/tag-merge-eval/run.mjs --provider gemini --model gemini-2.5-flash      --runs 5
node scripts/tag-merge-eval/run.mjs --provider anthropic --model <claude-model-id>  --runs 5
```

Score a pre-computed output without any API call:

```sh
node scripts/tag-merge-eval/run.mjs --output out.json   # { "groups": [ { "tags": ["a","b"] }, … ] }
```

Validate the scorer itself (no key needed):

```sh
node --test scripts/tag-merge-eval/score.test.mjs
```

## Files

| File | Role |
| ---- | ---- |
| `fixtures/totohero-vocab.json` | frozen 296-tag input |
| `fixtures/totohero-ground-truth.json` | 18 must-merge groups + hard negatives |
| `prompt.mjs` | the `ai-organize` prompt (the precision lever — mirror it in the edge function) |
| `providers.mjs` | Gemini + Anthropic adapters (keys from env) |
| `score.mjs` | pairwise precision/recall + forbidden-merge + restraint |
| `score.test.mjs` | scorer self-test against the fixtures |
| `run.mjs` | orchestrator: N runs → per-run + aggregate + gate verdict |

## Caveats (read before trusting a verdict)

- **n = 1.** One user, one KO/EN language pair, one domain mix. A model passing
  totohero does **not** generalize. Build B and C ground-truth sets (the other
  ≥10-bookmark users) and adjudicate them independently before committing a model.
- **Overfit risk.** The ground truth was produced + approved by the same frontier
  family you might grade against. Treat a frontier "pass" with suspicion; the
  interesting question is whether a *cheaper* model clears it.
- **Prompt is part of the artifact under test.** `prompt.mjs` is graded, not just
  the model — improving the hard-negative few-shots is a valid way to raise a
  model's score.
