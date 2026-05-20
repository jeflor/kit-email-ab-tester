// Tournament bracket helper for single-elimination with byes.
//
// Pairs subjects up two-at-a-time within a stage. If there's an odd one out,
// it gets a "bye" to the next stage. Continues until one subject remains.
//
// For 5 subjects [S1, S2, S3, S4, S5]:
//   Stage 1: (S1 vs S2)  (S3 vs S4)  + S5 byes
//   Stage 2: (W1 vs W2)              + S5 byes
//   Stage 3: (W3 vs S5)
//   → 3 stages total
//
// For 4 subjects: 2 stages.  For 8: 3 stages.  For 6: 3 stages (with bye).

function buildStageMatches(subjectsIn) {
  const matches = [];
  const byes = [];
  let i = 0;
  while (i + 1 < subjectsIn.length) {
    matches.push({ a: subjectsIn[i], b: subjectsIn[i + 1] });
    i += 2;
  }
  if (i < subjectsIn.length) byes.push(subjectsIn[i]);
  return { matches, byes };
}

function totalStagesFor(n) {
  if (n <= 1) return 0;
  return Math.ceil(Math.log2(n));
}

// Total matches across all stages for N subjects.
// Each stage reduces field size by ~half via matches; one subject is the
// final winner so we play (n-1) matches total.
function totalMatchesFor(n) {
  return Math.max(0, n - 1);
}

// Walk through completed stages (each is { matches: [{outcome, ...}], byes: [...] })
// and produce the array of subjects entering the next stage.
//
// `completedStages` is an array of stage objects, each like:
//   { matches: [{ subject_a, subject_b, outcome }], byes: [subjectString] }
// outcome: 'a_won' | 'b_won' (we map our DB's 'winner_kept'/'challenger_won' upstream)
function subjectsAdvancingFromStage(stage) {
  const winners = [];
  for (const m of stage.matches) {
    winners.push(m.outcome === 'b_won' ? m.subject_b : m.subject_a);
  }
  return [...winners, ...stage.byes];
}

module.exports = {
  buildStageMatches,
  totalStagesFor,
  totalMatchesFor,
  subjectsAdvancingFromStage,
};
