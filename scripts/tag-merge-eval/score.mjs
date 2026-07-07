// Scoring for the tag-merge eval. Pure, dependency-free, name-based.
//
// A candidate model returns merge GROUPS (sets of tag names it would combine).
// We score that partition against the human-approved ground truth
// (totohero-ground-truth.json): the 18 must-merge equivalence classes plus a
// zero-tolerance list of must-NOT-merge hard negatives. Everything not in a
// ground-truth group is its own singleton class.
//
// Precision ≫ recall by design: a missed merge is cheap (the user runs Tidy Up
// again), a wrong merge destroys their taxonomy. So the gate is high merge
// precision AND zero forbidden merges; recall is informational.

export function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function unorderedPairs(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  }
  return out;
}

export function buildGroundTruth(gt) {
  const classOf = new Map();
  gt.groups.forEach((g, idx) => {
    for (const t of [g.canonical, ...g.members]) classOf.set(normalizeName(t), idx);
  });
  const forbidden = (gt.hard_negatives ?? []).map(([a, b]) => [normalizeName(a), normalizeName(b)]);
  return { classOf, forbidden, groupTags: new Set(classOf.keys()) };
}

/**
 * @param modelGroups array of arrays of tag names (each inner array = one merge group)
 * @param gt          parsed ground-truth fixture
 * @param vocabNames  optional full vocab (enables the restraint metric)
 */
export function score(modelGroups, gt, vocabNames = null) {
  const { classOf, forbidden, groupTags } = buildGroundTruth(gt);

  // Normalize; keep only real merges (≥2 distinct members).
  const groups = modelGroups
    .map((g) => [...new Set(g.map(normalizeName))])
    .filter((g) => g.length >= 2);

  const modelGroupOf = new Map();
  groups.forEach((g, idx) => g.forEach((t) => modelGroupOf.set(t, idx)));
  const coGroupedModel = (a, b) => modelGroupOf.has(a) && modelGroupOf.get(a) === modelGroupOf.get(b);
  const sameClassGT = (a, b) => classOf.has(a) && classOf.has(b) && classOf.get(a) === classOf.get(b);

  // Merge precision: of all pairs the model merged, fraction same-class in GT.
  let mergedPairs = 0;
  let correctPairs = 0;
  const badPairs = [];
  for (const g of groups) {
    for (const [a, b] of unorderedPairs(g)) {
      mergedPairs++;
      if (sameClassGT(a, b)) correctPairs++;
      else badPairs.push([a, b]);
    }
  }
  const mergePrecision = mergedPairs === 0 ? 1 : correctPairs / mergedPairs;

  // Merge recall: of all GT same-class pairs, fraction the model also merged.
  let gtPairs = 0;
  let recalledPairs = 0;
  for (const g of gt.groups) {
    const all = [g.canonical, ...g.members].map(normalizeName);
    for (const [a, b] of unorderedPairs(all)) {
      gtPairs++;
      if (coGroupedModel(a, b)) recalledPairs++;
    }
  }
  const mergeRecall = gtPairs === 0 ? 1 : recalledPairs / gtPairs;

  // Forbidden merges — zero tolerance, reported separately.
  const forbiddenViolations = forbidden.filter(([a, b]) => coGroupedModel(a, b));

  // Restraint — did the model leave roughly as many tags unmerged as the human?
  let restraint = null;
  if (vocabNames) {
    const vocab = vocabNames.map(normalizeName);
    const modelMerged = new Set(modelGroupOf.keys());
    const modelSingletons = vocab.filter((t) => !modelMerged.has(t)).length;
    const gtSingletons = vocab.filter((t) => !groupTags.has(t)).length;
    restraint = { modelSingletons, gtSingletons, overMergedTags: gtSingletons - modelSingletons };
  }

  return {
    mergePrecision,
    mergeRecall,
    forbiddenViolations,
    forbiddenCount: forbiddenViolations.length,
    badPairs,
    mergedPairs,
    correctPairs,
    gtPairs,
    recalledPairs,
    modelGroupCount: groups.length,
    restraint,
  };
}

export const GATE = { minPrecision: 0.95, maxForbidden: 0 };

export function passesGate(s) {
  return s.mergePrecision >= GATE.minPrecision && s.forbiddenCount <= GATE.maxForbidden;
}
