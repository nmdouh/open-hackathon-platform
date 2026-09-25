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

async function teamIn(h, name = 'Owner') {
  const o = await t.user(name);
  await o.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  const idea = (await o.post(`/api/hackathons/${h.id}/ideas`, { title: name, problem: 'P', solution: 'S', submit: true })).body.idea;
  o.team = (await o.post(`/api/ideas/${idea.id}/team`, { name: `${name} team` })).body.team;
  return o;
}

async function mentorIn(h, fields = {}) {
  const m = await t.user('Mentor');
  const r = await admin.post(`/api/hackathons/${h.id}/mentors`, { email: m.email, expertise: ['data'], ...fields });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return m;
}

test('participants cannot become mentors and mentors cannot register', async () => {
  const h = await t.openHackathon(admin);
  const o = await teamIn(h);
  const r = await admin.post(`/api/hackathons/${h.id}/mentors`, { userId: o.user.id });
  assert.equal(r.body.error.code, 'MENTOR_IS_PARTICIPANT');
  const m = await mentorIn(h);
  const reg = await m.post(`/api/hackathons/${h.id}/registration`, { role: 'member' });
  assert.equal(reg.body.error.code, 'MENTORS_CANNOT_REGISTER');
});

test('request, accept (claims the team), complete with notes', async () => {
  const h = await t.openHackathon(admin);
  const o = await teamIn(h);
  const m = await mentorIn(h);
  const outsider = await t.user('Nosy');
  assert.equal((await outsider.post(`/api/teams/${o.team.id}/mentoring-requests`, { topic: 'x' })).status, 403);
  const req = (await o.post(`/api/teams/${o.team.id}/mentoring-requests`, { topic: 'Data pipeline review' })).body.request;
  const queue = await m.get(`/api/hackathons/${h.id}/mentoring/requests`);
  assert.equal(queue.body.requests.length, 1);
  const acc = await m.post(`/api/mentoring-requests/${req.id}/accept`, { scheduledAt: '2026-10-03T10:00:00Z' });
  assert.equal(acc.body.request.status, 'accepted');
  const mentors = await o.get(`/api/teams/${o.team.id}/mentors`);
  assert.equal(mentors.body.mentors[0].userId, m.user.id);
  const done = await m.post(`/api/mentoring-requests/${req.id}/complete`, { notes: 'Cache the lookups.' });
  assert.equal(done.body.request.status, 'done');
  const history = await o.get(`/api/hackathons/${h.id}/mentoring/requests?teamId=${o.team.id}`);
  assert.equal(history.body.requests[0].mentorNotes, 'Cache the lookups.');
  assert.equal((await outsider.get(`/api/hackathons/${h.id}/mentoring/requests?teamId=${o.team.id}`)).status, 403);
});

test('mentor capacity is enforced', async () => {
  const h = await t.openHackathon(admin);
  const a = await teamIn(h, 'A');
  const b = await teamIn(h, 'B');
  const m = await mentorIn(h, { maxTeams: 1 });
  assert.equal((await admin.raw('PUT', `/api/teams/${a.team.id}/mentors/${m.user.id}`)).status, 204);
  const full = await admin.raw('PUT', `/api/teams/${b.team.id}/mentors/${m.user.id}`);
  assert.equal(full.body.error.code, 'MENTOR_AT_CAPACITY');
  const req = (await b.post(`/api/teams/${b.team.id}/mentoring-requests`, { topic: 'Help' })).body.request;
  assert.equal((await m.post(`/api/mentoring-requests/${req.id}/accept`)).body.error.code, 'MENTOR_AT_CAPACITY');
});

test('addressed requests go to that mentor; declining returns them to the queue', async () => {
  const h = await t.openHackathon(admin);
  const o = await teamIn(h);
  const m1 = await mentorIn(h);
  const m2 = await mentorIn(h);
  const req = (await o.post(`/api/teams/${o.team.id}/mentoring-requests`, { topic: 'UX', mentorId: m1.user.id })).body.request;
  assert.equal((await m2.get(`/api/hackathons/${h.id}/mentoring/requests`)).body.requests.length, 0);
  assert.equal((await m2.post(`/api/mentoring-requests/${req.id}/accept`)).body.error.code, 'ADDRESSED_TO_ANOTHER_MENTOR');
  await m1.post(`/api/mentoring-requests/${req.id}/decline`);
  assert.equal((await m2.get(`/api/hackathons/${h.id}/mentoring/requests`)).body.requests.length, 1);
});

test('a team can have at most three open requests', async () => {
  const h = await t.openHackathon(admin);
  const o = await teamIn(h);
  for (let i = 0; i < 3; i++) await o.post(`/api/teams/${o.team.id}/mentoring-requests`, { topic: `Q${i}` });
  const r = await o.post(`/api/teams/${o.team.id}/mentoring-requests`, { topic: 'Q4' });
  assert.equal(r.body.error.code, 'TOO_MANY_OPEN_REQUESTS');
});
