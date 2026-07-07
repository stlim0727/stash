// Scoring for the tag-merge eval. Pure, dependency-free, name-based.
//
// A candidate model returns merge GROUPS (sets of tag names it would combine).
// We score that partition against the human-approved ground truth
// (totohero-ground-truth.json): the must-merge equivalence classes plus a
// zero-tolerance list of must-NOT-merge hard negatives. Everything not in a
// ground-truth group is its own singleton class.
//
// Precision ≫ recall by design: a missed merge is cheap (the user runs Tidy Up
// again), a wrong merge destroys their taxonomy. So the gate is high merge
// precision AND zero forbidden merges AND enough recall that a no-op model can't
// pass; recall beyond the floor is informational.

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
  const classOf = new Map(); // name -> classId
  const classMembers = new Map(); // classId -> [names]
  gt.groups.forEach((g, idx) => {
    const all = [g.canonical, ...g.members].map(normalizeName);
    classMembers.set(idx, all);
    for (const t of all) classOf.set(t, idx);
  });

  // Expand each hard negative across the FULL ground-truth class of each named
  // tag, so merging any class-equivalent member trips the same violation
  // (e.g. [접영, backstroke] also forbids 접영 킥 + backstroke). A tag not in any
  // group is its own singleton class.
  const membersOf = (name) => {
    const n = normalizeName(name);
    return classOf.has(n) ? classMembers.get(classOf.get(n)) : [n];
  };
  const forbiddenExpanded = [];
  for (const [a, b] of gt.hard_negatives ?? []) {
    const la = normalizeName(a);
    const lb = normalizeName(b);
    for (const x of membersOf(a)) {
      for (const y of membersOf(b)) forbiddenExpanded.push([x, y, la, lb]);
    }
  }
  return { classOf, groupTags: new Set(classOf.keys()), forbiddenExpanded };
}

/**
 * @param modelGroups array of arrays of tag names (each inner array = one merge group)
 * @param gt          parsed ground-truth fixture
 * @param vocabNames  optional full vocab (enables the restraint metric)
 */
export function score(modelGroups, gt, vocabNames = null) {
  const { classOf, groupTags, forbiddenExpanded } = buildGroundTruth(gt);

  // Normalize; keep only real merges (≥2 distinct members).
  const groups = modelGroups
    .map((g) => [...new Set(g.map(normalizeName))])
    .filter((g) => g.length >= 2);

  // Multi-membership: a tag may (buggily) appear in more than one model group.
  // Track ALL groups per tag so an overlapping output can't hide a bad pairing
  // by having the tag's "correct" group overwrite its bad one.
  const modelGroupsOf = new Map(); // name -> Set(groupIndex)
  const overlappingTags = new Set();
  groups.forEach((g, idx) => {
    for (const t of g) {
      if (!modelGroupsOf.has(t)) modelGroupsOf.set(t, new Set());
      const set = modelGroupsOf.get(t);
      if (set.size >= 1) overlappingTags.add(t);
      set.add(idx);
    }
  });
  const coGroupedModel = (a, b) => {
    const sa = modelGroupsOf.get(a);
    const sb = modelGroupsOf.get(b);
    if (!sa || !sb) return false;
    for (const i of sa) if (sb.has(i)) return true;
    return false;
  };
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

  // Forbidden merges — zero tolerance. Reported as the literal hard-negative
  // pairs violated (deduped), even when triggered by a class-equivalent member.
  const violated = new Map();
  for (const [x, y, la, lb] of forbiddenExpanded) {
    if (coGroupedModel(x, y)) violated.set(`${la}||${lb}`, [la, lb]);
  }
  const forbiddenViolations = [...violated.values()];

  // Restraint — did the model leave roughly as many tags unmerged as the human?
  let restraint = null;
  if (vocabNames) {
    const vocab = vocabNames.map(normalizeName);
    const modelMerged = new Set(modelGroupsOf.keys());
    const modelSingletons = vocab.filter((t) => !modelMerged.has(t)).length;
    const gtSingletons = vocab.filter((t) => !groupTags.has(t)).length;
    restraint = { modelSingletons, gtSingletons, overMergedTags: gtSingletons - modelSingletons };
  }

  return {
    mergePrecision,
    mergeRecall,
    forbiddenViolations,
    forbiddenCount: forbiddenViolations.length,
    overlappingTags: [...overlappingTags],
    badPairs,
    mergedPairs,
    correctPairs,
    gtPairs,
    recalledPairs,
    modelGroupCount: groups.length,
    restraint,
  };
}

// A model is shippable only if it doesn't over-merge (precision + zero forbidden)
// AND actually consolidates something (recall floor — else a no-op returning no
// groups would pass with vacuous 100% precision).
export const GATE = { minPrecision: 0.95, maxForbidden: 0, minRecall: 0.5 };

export function passesGate(s) {
  return (
    s.mergePrecision >= GATE.minPrecision &&
    s.forbiddenCount <= GATE.maxForbidden &&
    s.mergeRecall >= GATE.minRecall
  );
}
