'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await t.adminUser();
});
after(async () => { await t.close(); });

const IDEA = { problem: 'P', solution: 'S' };

// An open hackathon with `n` submitted ideas and a screening round in draft.
async function setup(n = 3, roundFields = {}) {
  const h = await t.openHackathon(admin);
  const owners = [];
  for (let i = 0; i < n; i++) {
    const o = await t.user(`Owner${i}`);
    await o.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
    o.idea = (await o.post(`/api/hackathons/${h.id}/ideas`, { title: `Idea ${i}`, ...IDEA, submit: true })).body.idea;
    owners.push(o);
  }
  const round = (await admin.post(`/api/hackathons/${h.id}/rounds`, {
    kind: 'screening', nameEn: 'Screening', minReviewers: 2, ...roundFields,
  })).body.round;
  const criteria = (await admin.get(`/api/rounds/${round.id}`)).body.criteria;
  return { h, owners, round, criteria };
}

async function committee(round, size = 3) {
  const members = [];
  for (let i = 0; i < size; i++) {
    const m = await t.user(`Reviewer${i}`);
    const r = await admin.post(`/api/rounds/${round.id}/reviewers`, { userId: m.user.id, isChair: i === 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    members.push(m);
  }
  return members;
}

const allScores = (criteria, value) => Object.fromEntries(criteria.map((c) => [c.id, value]));

test('templates seed weighted criteria; rounds open only when ready', async () => {
  const { round, criteria } = await setup(1);
  assert.equal(criteria.length, 4);
  assert.deepEqual(criteria.map((c) => Number(c.weight)).reduce((a, b) => a + b, 0), 100);
  const noReviewers = await admin.post(`/api/rounds/${round.id}/open`);
  assert.equal(noReviewers.body.error.code, 'ROUND_HAS_NO_REVIEWERS');
  await committee(round, 1);
  assert.equal((await admin.post(`/api/rounds/${round.id}/open`)).body.round.status, 'open');
  const late = await admin.post(`/api/rounds/${round.id}/criteria`, { nameEn: 'Late', weight: 5 });
  assert.equal(late.body.error.code, 'ROUND_NOT_DRAFT');
});

test('participants cannot sit on a committee, and reviewers cannot register', async () => {
  const { h, owners, round } = await setup(1);
  const r = await admin.post(`/api/rounds/${round.id}/reviewers`, { userId: owners[0].user.id });
  assert.equal(r.body.error.code, 'REVIEWER_IS_PARTICIPANT');
  const [rev] = await committee(round, 1);
  const reg = await rev.post(`/api/hackathons/${h.id}/registration`, { role: 'member' });
  assert.equal(reg.body.error.code, 'REVIEWERS_CANNOT_REGISTER');
});

test('only one chair per committee', async () => {
  const { round } = await setup(1);
  const [a] = await committee(round, 2);
  const b = await t.user('NewChair');
  await admin.post(`/api/rounds/${round.id}/reviewers`, { userId: b.user.id, isChair: true });
  const d = await admin.get(`/api/rounds/${round.id}`);
  const chairs = d.body.reviewers.filter((r) => r.isChair);
  assert.deepEqual(chairs.map((c) => c.userId), [b.user.id]);
  assert.ok(d.body.reviewers.some((r) => r.userId === a.user.id && !r.isChair));
});

test('evaluations: validation, server-side totals, no edits after the round closes', async () => {
  const { owners, round, criteria } = await setup(1);
  const [chair] = await committee(round, 2);
  await admin.post(`/api/rounds/${round.id}/open`);
  const idea = owners[0].idea.id;
  const url = `/api/rounds/${round.id}/candidates/${idea}/evaluation`;
  const missing = await chair.raw('PUT', url, { scores: { [criteria[0].id]: 5 }, submit: true, recommendation: 'advance' });
  assert.equal(missing.body.error.code, 'SCORES_INVALID');
  const noRec = await chair.raw('PUT', url, { scores: allScores(criteria, 5), submit: true });
  assert.equal(noRec.body.error.code, 'RECOMMENDATION_REQUIRED');
  const draft = await chair.raw('PUT', url, { scores: { [criteria[0].id]: 4 } });
  assert.equal(draft.body.evaluation.status, 'draft');
  const ok = await chair.raw('PUT', url, { scores: allScores(criteria, 5), submit: true, recommendation: 'advance', total: 1 });
  assert.equal(ok.status, 200);
  assert.equal(Number(ok.body.evaluation.total), 100);
  await admin.post(`/api/rounds/${round.id}/close`);
  const late = await chair.raw('PUT', url, { scores: allScores(criteria, 1), submit: true, recommendation: 'reject' });
  assert.equal(late.body.error.code, 'ROUND_NOT_OPEN');
});

test('non-reviewers see nothing; reviewers do not see each other’s scores', async () => {
  const { owners, round } = await setup(1);
  const [chair, member] = await committee(round, 2);
  await admin.post(`/api/rounds/${round.id}/open`);
  const outsider = await t.user('Outsider');
  assert.equal((await outsider.get(`/api/rounds/${round.id}`)).status, 404);
  assert.equal((await outsider.get(`/api/rounds/${round.id}/my-candidates`)).status, 403);
  assert.equal((await owners[0].get(`/api/rounds/${round.id}/board`)).status, 403);
  assert.equal((await member.get(`/api/rounds/${round.id}/board`)).status, 403);
  assert.equal((await member.get(`/api/rounds/${round.id}/candidates/${owners[0].idea.id}/evaluations`)).status, 403);
  assert.equal((await chair.get(`/api/rounds/${round.id}/board`)).status, 200);
  const mine = await member.get(`/api/rounds/${round.id}/my-candidates`);
  assert.equal(mine.body.candidates.length, 1);
});

test('mentors of a team are blocked from evaluating it', async () => {
  const { h, owners, round, criteria } = await setup(1);
  const [chair] = await committee(round, 1);
  await owners[0].post(`/api/ideas/${owners[0].idea.id}/team`, { name: 'Team' });
  const team = (await owners[0].get(`/api/hackathons/${h.id}/me`)).body.membership.teamId;
  assert.equal((await admin.post(`/api/hackathons/${h.id}/mentors`, { userId: chair.user.id })).status, 201);
  assert.equal((await admin.raw('PUT', `/api/teams/${team}/mentors/${chair.user.id}`)).status, 204);
  await admin.post(`/api/rounds/${round.id}/open`);
  const list = await chair.get(`/api/rounds/${round.id}/my-candidates`);
  assert.equal(list.body.candidates[0].autoConflict, 'mentors_team');
  const r = await chair.raw('PUT', `/api/rounds/${round.id}/candidates/${owners[0].idea.id}/evaluation`, {
    scores: allScores(criteria, 3), submit: true, recommendation: 'advance',
  });
  assert.equal(r.body.error.code, 'CONFLICT_OF_INTEREST');
});

test('full committee flow: votes, declared conflict, override needs a reason, finalise, next round', async () => {
  const { h, owners, round, criteria } = await setup(3, { advanceCount: 1 });
  const [chair, m1, m2] = await committee(round, 3);
  await admin.post(`/api/rounds/${round.id}/open`);
  const vote = (who, idea, value, rec) => who.raw('PUT', `/api/rounds/${round.id}/candidates/${idea}/evaluation`, {
    scores: allScores(criteria, value), submit: true, recommendation: rec,
  });
  const [i0, i1, i2] = owners.map((o) => o.idea.id);
  // Idea 0 scores high, idea 1 middling, idea 2 gets only one counted vote.
  await vote(chair, i0, 5, 'advance');
  await vote(m1, i0, 4, 'advance');
  await vote(chair, i1, 3, 'hold');
  await vote(m1, i1, 3, 'hold');
  await vote(m2, i2, 2, 'reject');
  const conflictNoReason = await m2.raw('PUT', `/api/rounds/${round.id}/candidates/${i0}/evaluation`, { conflict: true });
  assert.equal(conflictNoReason.body.error.code, 'CONFLICT_REASON_REQUIRED');
  await m2.raw('PUT', `/api/rounds/${round.id}/candidates/${i0}/evaluation`, { conflict: true, conflictReason: 'Former colleague' });

  const b = await chair.get(`/api/rounds/${round.id}/board`);
  const row = (id) => b.body.rows.find((r) => r.ideaId === id);
  assert.equal(row(i0).aggregate.reviewerCount, 2);
  assert.equal(row(i0).aggregate.conflicts, 1);
  assert.equal(row(i0).aggregate.score, 87.5);
  assert.equal(row(i0).rank, 1);
  assert.equal(row(i0).suggestion, 'advance');
  assert.equal(row(i1).suggestion, 'reject');
  assert.equal(row(i2).suggestion, null);
  assert.equal(row(i2).aggregate.meetsMinimum, false);

  // Only the chair or an admin decides.
  assert.equal((await m1.raw('PUT', `/api/rounds/${round.id}/decisions/${i1}`, { outcome: 'advance' })).status, 403);
  // Going against the suggestion is an override and needs a reason.
  const bare = await chair.raw('PUT', `/api/rounds/${round.id}/decisions/${i1}`, { outcome: 'advance' });
  assert.equal(bare.body.error.code, 'NOTE_REQUIRED_FOR_OVERRIDE');
  const over = await chair.raw('PUT', `/api/rounds/${round.id}/decisions/${i1}`, { outcome: 'advance', note: 'Strategic priority' });
  assert.equal(over.body.decision.isOverride, true);

  assert.equal((await chair.post(`/api/rounds/${round.id}/finalize`, {})).body.error.code, 'CLOSE_ROUND_FIRST');
  await admin.post(`/api/rounds/${round.id}/close`);
  assert.equal((await chair.post(`/api/rounds/${round.id}/finalize`, {})).body.error.code, 'UNDECIDED_CANDIDATES');
  const stuck = await chair.post(`/api/rounds/${round.id}/finalize`, { applySuggestions: true });
  assert.equal(stuck.body.error.code, 'NO_SUGGESTION_FOR_SOME');
  assert.deepEqual(stuck.body.error.details, [i2]);
  await chair.raw('PUT', `/api/rounds/${round.id}/decisions/${i2}`, { outcome: 'reject', note: 'Not enough votes; clearly out of scope' });
  const fin = await chair.post(`/api/rounds/${round.id}/finalize`, { applySuggestions: true });
  assert.equal(fin.body.round.status, 'finalized');
  assert.equal((await chair.raw('PUT', `/api/rounds/${round.id}/decisions/${i0}`, { outcome: 'reject', note: 'x' })).body.error.code, 'ROUND_STATE');

  // Audit keeps overrides with their reason.
  const log = await admin.get(`/api/admin/audit?hackathonId=${h.id}&limit=200`);
  const override = log.body.entries.find((e) => e.action === 'decision.override' && e.entityId === i1);
  assert.equal(override.details.note, 'Strategic priority');
  assert.equal(override.details.suggestion, 'reject');

  // Results stay private until published; then only advancing ideas are listed.
  assert.equal((await owners[2].get(`/api/hackathons/${h.id}/results`)).body.rounds.length, 0);
  await admin.post(`/api/rounds/${round.id}/publish`, { published: true });
  const res = await owners[2].get(`/api/hackathons/${h.id}/results`);
  assert.deepEqual(res.body.rounds[0].advanced.map((a) => a.ideaId).sort(), [i0, i1].sort());
  assert.equal(res.body.rounds[0].myOutcome, 'reject');

  // The next round draws its candidates from the advanced ideas only.
  const next = (await admin.post(`/api/hackathons/${h.id}/rounds`, {
    kind: 'final', nameEn: 'Final', sourceRoundId: round.id, minReviewers: 1,
  })).body.round;
  const judge = await t.user('Judge');
  await admin.post(`/api/rounds/${next.id}/reviewers`, { userId: judge.user.id, isChair: true });
  await admin.post(`/api/rounds/${next.id}/open`);
  const cands = await judge.get(`/api/rounds/${next.id}/my-candidates`);
  assert.deepEqual(cands.body.candidates.map((c) => c.id).sort(), [i0, i1].sort());
  const finalCriteria = (await judge.get(`/api/rounds/${next.id}`)).body.criteria;
  assert.equal(finalCriteria[0].maxScore, 10);
});

test('a round cannot open before its source round is finalised', async () => {
  const { h, round } = await setup(1);
  const next = (await admin.post(`/api/hackathons/${h.id}/rounds`, { kind: 'review', nameEn: 'Review', sourceRoundId: round.id })).body.round;
  const j = await t.user('J');
  await admin.post(`/api/rounds/${next.id}/reviewers`, { userId: j.user.id });
  assert.equal((await admin.post(`/api/rounds/${next.id}/open`)).body.error.code, 'SOURCE_ROUND_NOT_FINALIZED');
  assert.equal((await admin.del(`/api/rounds/${round.id}`)).body.error.code, 'ROUND_IS_A_SOURCE');
});

test('assigned mode limits each reviewer to their assigned ideas', async () => {
  const { owners, round, criteria } = await setup(2, { assignmentMode: 'assigned', minReviewers: 1 });
  const [a, b] = await committee(round, 2);
  const [i0, i1] = owners.map((o) => o.idea.id);
  await admin.raw('PUT', `/api/rounds/${round.id}/assignments/${i0}`, { reviewerIds: [a.user.id] });
  await admin.raw('PUT', `/api/rounds/${round.id}/assignments/${i1}`, { reviewerIds: [b.user.id] });
  await admin.post(`/api/rounds/${round.id}/open`);
  assert.deepEqual((await a.get(`/api/rounds/${round.id}/my-candidates`)).body.candidates.map((c) => c.id), [i0]);
  const wrong = await a.raw('PUT', `/api/rounds/${round.id}/candidates/${i1}/evaluation`, {
    scores: allScores(criteria, 3), submit: true, recommendation: 'hold',
  });
  assert.equal(wrong.body.error.code, 'NOT_ASSIGNED');
});

test('reviewers with submitted votes cannot be silently removed', async () => {
  const { owners, round, criteria } = await setup(1);
  const [chair] = await committee(round, 1);
  await admin.post(`/api/rounds/${round.id}/open`);
  await chair.raw('PUT', `/api/rounds/${round.id}/candidates/${owners[0].idea.id}/evaluation`, {
    scores: allScores(criteria, 3), submit: true, recommendation: 'hold',
  });
  const r = await admin.del(`/api/rounds/${round.id}/reviewers/${chair.user.id}`);
  assert.equal(r.body.error.code, 'REVIEWER_HAS_SUBMITTED');
});
