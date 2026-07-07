// Tag-merge eval runner.
//
//   node scripts/tag-merge-eval/run.mjs --provider gemini   --model gemini-2.5-flash --runs 5
//   node scripts/tag-merge-eval/run.mjs --provider gemini   --model gemini-2.5-flash-lite --runs 5
//   node scripts/tag-merge-eval/run.mjs --provider anthropic --model <claude-model-id> --runs 5
//
// Or score a pre-computed model output (no API call):
//   node scripts/tag-merge-eval/run.mjs --output path/to/output.json
//   (output.json = { "groups": [ { "tags": ["a","b"] }, ... ] })
//
// Keys: GEMINI_API_KEY / ANTHROPIC_API_KEY in the environment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { score, passesGate, GATE } from './score.mjs';
import { PROVIDERS } from './providers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Minimum runs before a model may be blessed as shippable (temp 0.1 is still
// stochastic; one lucky pass must not decide a production model).
const MIN_RUNS = 5;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const vocabPath = resolve(arg('vocab', join(here, 'fixtures/totohero-vocab.json')));
const gtPath = resolve(arg('gt', join(here, 'fixtures/totohero-ground-truth.json')));
const vocab = JSON.parse(readFileSync(vocabPath, 'utf8')).tags;
const vocabNames = vocab.map((t) => t.name);
const gt = JSON.parse(readFileSync(gtPath, 'utf8'));

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function report(label, s) {
  console.log(`\n── ${label} ──`);
  console.log(`  merge precision : ${pct(s.mergePrecision)}  (${s.correctPairs}/${s.mergedPairs} merged pairs correct)`);
  console.log(`  merge recall    : ${pct(s.mergeRecall)}  (${s.recalledPairs}/${s.gtPairs} ground-truth pairs found)`);
  console.log(`  forbidden merges: ${s.forbiddenCount}${s.forbiddenCount ? '  ⛔ ' + s.forbiddenViolations.map((p) => p.join('+')).join(', ') : ''}`);
  console.log(`  model groups    : ${s.modelGroupCount}`);
  if (s.restraint) {
    console.log(`  restraint       : left ${s.restraint.modelSingletons} unmerged vs ${s.restraint.gtSingletons} in truth (over-merged ${s.restraint.overMergedTags})`);
  }
  if (s.badPairs.length) {
    console.log(`  sample bad merges: ${s.badPairs.slice(0, 8).map((p) => p.join('+')).join(', ')}${s.badPairs.length > 8 ? ' …' : ''}`);
  }
  if (s.overlappingTags.length) {
    console.log(`  ⛔ overlapping tags (in >1 group): ${s.overlappingTags.slice(0, 8).join(', ')}${s.overlappingTags.length > 8 ? ' …' : ''}`);
  }
  if (s.unknownTags.length) {
    console.log(`  ⛔ tags not in vocab (hallucinated): ${s.unknownTags.slice(0, 8).join(', ')}${s.unknownTags.length > 8 ? ' …' : ''}`);
  }
  console.log(`  GATE (prec ≥ ${pct(GATE.minPrecision)} & recall ≥ ${pct(GATE.minRecall)} & 0 forbidden & no overlap/unknown): ${passesGate(s) ? 'PASS ✅' : 'FAIL ❌'}`);
}

async function main() {
  const outputArg = arg('output');
  if (outputArg) {
    // Score one or more precomputed outputs (comma-separated). A SINGLE output is
    // diagnostic only — it reports the per-sample gate but never a shippable
    // verdict, since blessing a production model needs ≥ MIN_RUNS samples (one
    // lucky JSON must not read as a passing eval). Pass ≥ MIN_RUNS files to get a
    // real aggregate verdict, the same rule as live provider runs.
    const paths = outputArg.split(',').map((p) => p.trim()).filter(Boolean);
    const results = paths.map((p) => {
      const out = JSON.parse(readFileSync(resolve(p), 'utf8'));
      return { p, s: score((out.groups ?? []).map((g) => g.tags ?? []), gt, vocabNames) };
    });
    results.forEach(({ p, s }) => report(`output: ${p}`, s));
    const allPass = results.every((r) => passesGate(r.s));
    if (paths.length >= MIN_RUNS) {
      console.log(`\n══ AGGREGATE (${paths.length} outputs) ══`);
      console.log(`  VERDICT : ${allPass ? `SHIPPABLE ✅ (gate held on all ${paths.length})` : 'NOT shippable ❌'}`);
      if (!allPass) process.exitCode = 1;
    } else {
      console.log(`\nDIAGNOSTIC — ${paths.length} sample(s). A shippable verdict needs ≥ ${MIN_RUNS} outputs (or live runs); this only reports the per-sample gate.`);
      if (!allPass) process.exitCode = 1; // still surface a broken sample for CI
    }
    return;
  }

  const provider = arg('provider', 'gemini');
  const model = arg('model');
  const runs = Number(arg('runs', '5'));
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer (got ${arg('runs')})`);
  const run = PROVIDERS[provider];
  if (!run) throw new Error(`Unknown provider "${provider}" (expected: ${Object.keys(PROVIDERS).join(', ')})`);

  console.log(`Eval: ${provider}${model ? ` (${model})` : ''} · ${runs} run(s) · ${vocab.length} tags · truth = ${gt.groups.length} groups, ${gt.hard_negatives.length} hard negatives`);

  const scores = [];
  let failures = 0;
  for (let i = 0; i < runs; i++) {
    let groups;
    try {
      const out = await run(vocab, { model });
      groups = out.map((g) => g.tags ?? []);
    } catch (err) {
      failures++;
      console.error(`  run ${i + 1} failed: ${err.message}`);
      continue;
    }
    const s = score(groups, gt, vocabNames);
    scores.push(s);
    report(`run ${i + 1}/${runs}`, s);
  }

  const mean = (f) => (scores.length ? scores.reduce((a, s) => a + f(s), 0) / scores.length : 0);
  const anyForbidden = scores.some((s) => s.forbiddenCount > 0);
  // Shippable requires the minimum sample size AND every requested run to
  // complete AND pass the gate. A run that errored out (transient API/parse
  // failure) is not a pass, and fewer than MIN_RUNS is too small a sample to
  // bless a production model (temp 0.1 is still stochastic).
  const enoughRuns = runs >= MIN_RUNS;
  const shippable = enoughRuns && scores.length === runs && scores.every(passesGate) && !anyForbidden;

  console.log(`\n══ AGGREGATE (${scores.length}/${runs} runs completed) ══`);
  console.log(`  mean precision  : ${pct(mean((s) => s.mergePrecision))}`);
  console.log(`  mean recall     : ${pct(mean((s) => s.mergeRecall))}`);
  console.log(`  forbidden merges: ${anyForbidden ? 'PRESENT in ≥1 run ⛔' : 'none across completed runs'}`);
  if (!enoughRuns) console.log(`  sample too small: need ≥ ${MIN_RUNS} runs to bless a model → not shippable`);
  if (failures) console.log(`  incomplete      : ${failures} run(s) failed → not shippable`);
  console.log(`  VERDICT         : ${shippable ? `SHIPPABLE ✅ (gate held on all ${runs} runs)` : 'NOT shippable ❌'}`);
  if (!shippable) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
