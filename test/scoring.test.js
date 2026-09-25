'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { weightedTotal, validateScores, aggregate, suggest } = require('../server/modules/governance/scoring');

const criteria = [
  { id: 'a', weight: 30, min_score: 1, max_score: 5 },
  { id: 'b', weight: 70, min_score: 1, max_score: 5 },
];

test('weighted total normalises each criterion and scales to 100', () => {
  assert.equal(weightedTotal(criteria, { a: 5, b: 5 }), 100);
  assert.equal(weightedTotal(criteria, { a: 1, b: 1 }), 0);
  // a at 50% of range * 30 + b at 75% * 70 = 15 + 52.5
  assert.equal(weightedTotal(criteria, { a: 3, b: 4 }), 67.5);
});

test('weights need not sum to 100', () => {
  const c = [{ id: 'x', weight: 1, min_score: 0, max_score: 10 }, { id: 'y', weight: 3, min_score: 0, max_score: 10 }];
  assert.equal(weightedTotal(c, { x: 10, y: 0 }), 25);
});

test('score validation catches missing, out-of-range, bad step and unknown criteria', () => {
  assert.equal(validateScores(criteria, { a: 3, b: 4 }), null);
  assert.equal(validateScores(criteria, { a: 3 }).problem, 'missing');
  assert.equal(validateScores(criteria, { a: 6, b: 1 }).problem, 'out_of_range');
  assert.equal(validateScores(criteria, { a: 2.25, b: 1 }).problem, 'step');
  assert.equal(validateScores(criteria, { a: 2.5, b: 1 }), null);
  assert.equal(validateScores(criteria, { a: 2, b: 1, z: 1 }).problem, 'unknown');
});

test('aggregation ignores drafts and declared conflicts', () => {
  const agg = aggregate([
    { status: 'submitted', conflict: false, total: '80', recommendation: 'advance' },
    { status: 'submitted', conflict: false, total: '60', recommendation: 'hold' },
    { status: 'draft', conflict: false, total: null },
    { status: 'submitted', conflict: true, total: null },
  ], 2);
  assert.equal(agg.score, 70);
  assert.equal(agg.reviewerCount, 2);
  assert.equal(agg.conflicts, 1);
  assert.equal(agg.drafts, 1);
  assert.equal(agg.meetsMinimum, true);
  assert.deepEqual(agg.recommendations, { advance: 1, hold: 1, reject: 0 });
  assert.equal(aggregate([], 1).score, null);
});

const cand = (id, score, recs = {}, meets = true) => ({
  id, aggregate: { score, meetsMinimum: meets, recommendations: { advance: 0, hold: 0, reject: 0, ...recs } },
});

test('top-N suggestion keeps ties at the cut-off together', () => {
  const out = suggest([cand('a', 90), cand('b', 80), cand('c', 80), cand('d', 50), cand('e', null, {}, false)], { advanceCount: 2 });
  const by = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.equal(by.a.suggestion, 'advance');
  assert.equal(by.b.suggestion, 'advance');
  assert.equal(by.c.suggestion, 'advance');
  assert.equal(by.d.suggestion, 'reject');
  assert.equal(by.e.suggestion, null);
  assert.deepEqual([by.a.rank, by.b.rank, by.c.rank, by.d.rank, by.e.rank], [1, 2, 2, 4, null]);
});

test('without a quota the committee majority decides, ties wait-list', () => {
  const out = suggest([
    cand('x', 70, { advance: 3, reject: 1 }),
    cand('y', 60, { hold: 2 }),
    cand('z', 50, { advance: 1, reject: 1 }),
  ], { advanceCount: null });
  assert.deepEqual(out.map((o) => o.suggestion), ['advance', 'waitlist', 'waitlist']);
});

test('advance count of zero rejects everyone', () => {
  assert.deepEqual(suggest([cand('a', 99)], { advanceCount: 0 }).map((o) => o.suggestion), ['reject']);
});
