'use strict';

// Pure scoring functions, kept free of database access so they are easy to
// test and to reason about.

// Weighted total on a 0-100 scale:
//   sum over criteria of ((score - min) / (max - min)) * weight / sum(weights) * 100
function weightedTotal(criteria, scores) {
  const totalWeight = criteria.reduce((s, c) => s + Number(c.weight), 0);
  if (!totalWeight) return null;
  let sum = 0;
  for (const c of criteria) {
    const raw = Number(scores[c.id]);
    if (!Number.isFinite(raw)) return null;
    sum += ((raw - c.min_score) / (c.max_score - c.min_score)) * Number(c.weight);
  }
  return Math.round((sum / totalWeight) * 100 * 1000) / 1000;
}

// Returns the first problem with a score set, or null when it is complete and in range.
function validateScores(criteria, scores) {
  for (const c of criteria) {
    const v = scores[c.id];
    if (v === undefined || v === null || v === '') return { criterionId: c.id, problem: 'missing' };
    const n = Number(v);
    if (!Number.isFinite(n) || n < c.min_score || n > c.max_score) return { criterionId: c.id, problem: 'out_of_range' };
    if (Math.round(n * 2) !== n * 2) return { criterionId: c.id, problem: 'step' };
  }
  const known = new Set(criteria.map((c) => c.id));
  const extra = Object.keys(scores).find((k) => !known.has(k));
  return extra ? { criterionId: extra, problem: 'unknown' } : null;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// Aggregates one candidate's evaluations. Only submitted, non-conflicted
// evaluations count; drafts and declared conflicts are reported separately.
function aggregate(evaluations, minReviewers) {
  const counted = evaluations.filter((e) => e.status === 'submitted' && !e.conflict && e.total !== null);
  const totals = counted.map((e) => Number(e.total));
  const n = totals.length;
  const mean = n ? totals.reduce((a, b) => a + b, 0) / n : null;
  const spread = n > 1 ? Math.sqrt(totals.reduce((a, t) => a + (t - mean) ** 2, 0) / (n - 1)) : 0;
  const recommendations = { advance: 0, hold: 0, reject: 0 };
  for (const e of counted) if (e.recommendation) recommendations[e.recommendation] += 1;
  return {
    score: mean === null ? null : round3(mean),
    spread: round3(spread),
    reviewerCount: n,
    conflicts: evaluations.filter((e) => e.conflict).length,
    drafts: evaluations.filter((e) => e.status === 'draft').length,
    recommendations,
    meetsMinimum: n >= minReviewers,
  };
}

// Ranks candidates and derives a suggested outcome for each one.
// - With advanceCount: every candidate scoring at least the Nth best score
//   advances (ties at the boundary all advance), the rest are rejected.
// - Without it: the committee's majority recommendation (ties -> waitlist).
// Candidates below the minimum number of reviewers get no suggestion; any
// decision on them is an override that needs a written reason.
function suggest(candidates, { advanceCount }) {
  const ranked = candidates
    .filter((c) => c.aggregate.meetsMinimum)
    .sort((a, b) => b.aggregate.score - a.aggregate.score);
  const rank = new Map();
  ranked.forEach((c, i) => {
    const prev = ranked[i - 1];
    rank.set(c.id, prev && prev.aggregate.score === c.aggregate.score ? rank.get(prev.id) : i + 1);
  });
  const cutoff = advanceCount && ranked.length
    ? ranked[Math.min(advanceCount, ranked.length) - 1].aggregate.score
    : null;
  return candidates.map((c) => {
    let suggestion = null;
    if (c.aggregate.meetsMinimum) {
      if (advanceCount !== null && advanceCount !== undefined) {
        suggestion = advanceCount > 0 && c.aggregate.score >= cutoff ? 'advance' : 'reject';
      } else {
        const r = c.aggregate.recommendations;
        const top = Math.max(r.advance, r.hold, r.reject);
        if (top > 0) {
          const leaders = ['advance', 'hold', 'reject'].filter((k) => r[k] === top);
          suggestion = leaders.length === 1 ? (leaders[0] === 'hold' ? 'waitlist' : leaders[0]) : 'waitlist';
        }
      }
    }
    return { ...c, rank: rank.get(c.id) ?? null, suggestion };
  });
}

module.exports = { weightedTotal, validateScores, aggregate, suggest };
