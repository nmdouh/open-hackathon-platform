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

const IDEA = { title: 'Queue-free clinic', problem: 'Long waits', solution: 'Smart triage' };

async function owner(h, name = 'Owner') {
  const u = await t.user(name);
  assert.equal((await u.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' })).status, 201);
  const idea = await u.post(`/api/hackathons/${h.id}/ideas`, { ...IDEA, submit: true });
  assert.equal(idea.status, 201, JSON.stringify(idea.body));
  const team = await u.post(`/api/ideas/${idea.body.idea.id}/team`, { name: `${name} team` });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  u.idea = idea.body.idea;
  u.team = team.body.team;
  return u;
}

async function member(h, name = 'Member') {
  const u = await t.user(name);
  assert.equal((await u.post(`/api/hackathons/${h.id}/registration`, { role: 'member', skills: ['design'] })).status, 201);
  return u;
}

test('one active registration per person per hackathon', async () => {
  const h = await t.openHackathon(admin);
  const u = await member(h);
  const again = await u.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_REGISTERED');
  // Withdrawing frees the slot for a fresh registration.
  assert.equal((await u.del(`/api/hackathons/${h.id}/registration`)).status, 204);
  assert.equal((await u.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' })).status, 201);
});

test('only idea owners submit ideas, and only one live idea each', async () => {
  const h = await t.openHackathon(admin);
  const m = await member(h);
  const r = await m.post(`/api/hackathons/${h.id}/ideas`, IDEA);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'ONLY_IDEA_OWNERS_SUBMIT');
  const o = await owner(h);
  const second = await o.post(`/api/hackathons/${h.id}/ideas`, IDEA);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'IDEA_EXISTS');
});

test('an idea needs a title, problem and solution before submission', async () => {
  const h = await t.openHackathon(admin);
  const u = await t.user('Drafter');
  await u.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  const draft = await u.post(`/api/hackathons/${h.id}/ideas`, { title: 'Half an idea' });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.idea.status, 'draft');
  const early = await u.post(`/api/ideas/${draft.body.idea.id}/submit`);
  assert.equal(early.status, 400);
  assert.equal(early.body.error.code, 'IDEA_INCOMPLETE');
  const noTeam = await u.post(`/api/ideas/${draft.body.idea.id}/team`, { name: 'Too soon' });
  assert.equal(noTeam.body.error.code, 'IDEA_NOT_SUBMITTED');
  await u.patch(`/api/ideas/${draft.body.idea.id}`, { problem: 'P', solution: 'S' });
  assert.equal((await u.post(`/api/ideas/${draft.body.idea.id}/submit`)).body.idea.status, 'submitted');
});

test('drafts are private; submitted ideas are visible to participants', async () => {
  const h = await t.openHackathon(admin);
  const drafter = await t.user('Private');
  await drafter.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  const draft = await drafter.post(`/api/hackathons/${h.id}/ideas`, { title: 'Secret' });
  const o = await owner(h, 'Public');
  const m = await member(h);
  const list = await m.get(`/api/hackathons/${h.id}/ideas`);
  assert.deepEqual(list.body.ideas.map((i) => i.id), [o.idea.id]);
  assert.equal((await m.get(`/api/ideas/${draft.body.idea.id}`)).status, 404);
  assert.equal((await admin.get(`/api/hackathons/${h.id}/ideas`)).body.ideas.length, 2);
  const outsider = await t.user('Outsider');
  assert.equal((await outsider.get(`/api/hackathons/${h.id}/ideas`)).status, 403);
});

test('one team per idea and per owner', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const again = await o.post(`/api/ideas/${o.idea.id}/team`, { name: 'Second' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_IN_TEAM');
  const m = await member(h);
  const steal = await m.post(`/api/ideas/${o.idea.id}/team`, { name: 'Mine now' });
  assert.equal(steal.status, 403);
});

test('idea owners cannot apply to other teams', async () => {
  const h = await t.openHackathon(admin);
  const a = await owner(h, 'Alpha');
  const b = await owner(h, 'Beta');
  const r = await b.post(`/api/teams/${a.team.id}/applications`, { message: 'hi' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'IDEA_OWNERS_CANNOT_APPLY');
});

test('no duplicate pending application, and a cap on open applications', async () => {
  const h = await t.openHackathon(admin, { maxPendingApplications: 2 });
  const teams = [await owner(h, 'T1'), await owner(h, 'T2'), await owner(h, 'T3')];
  const m = await member(h);
  assert.equal((await m.post(`/api/teams/${teams[0].team.id}/applications`)).status, 201);
  const dup = await m.post(`/api/teams/${teams[0].team.id}/applications`);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_APPLICATION');
  assert.equal((await m.post(`/api/teams/${teams[1].team.id}/applications`)).status, 201);
  const third = await m.post(`/api/teams/${teams[2].team.id}/applications`);
  assert.equal(third.body.error.code, 'TOO_MANY_PENDING_APPLICATIONS');
});

test('accepting an application cancels the member’s other applications', async () => {
  const h = await t.openHackathon(admin);
  const a = await owner(h, 'A');
  const b = await owner(h, 'B');
  const m = await member(h);
  const appA = (await m.post(`/api/teams/${a.team.id}/applications`)).body.application;
  const appB = (await m.post(`/api/teams/${b.team.id}/applications`)).body.application;
  const stranger = await member(h, 'Stranger');
  assert.equal((await stranger.post(`/api/applications/${appA.id}/accept`)).status, 403);
  const ok = await a.post(`/api/applications/${appA.id}/accept`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.application.status, 'accepted');
  const mine = await m.get(`/api/hackathons/${h.id}/me`);
  assert.equal(mine.body.membership.teamId, a.team.id);
  assert.equal(mine.body.applications.find((x) => x.id === appB.id).status, 'cancelled');
  const late = await b.post(`/api/applications/${appB.id}/accept`);
  assert.equal(late.body.error.code, 'APPLICATION_NOT_PENDING');
  const apply = await m.post(`/api/teams/${b.team.id}/applications`);
  assert.equal(apply.body.error.code, 'ALREADY_IN_TEAM');
});

test('team capacity is enforced', async () => {
  const h = await t.openHackathon(admin, { minTeamSize: 1, maxTeamSize: 2 });
  const o = await owner(h);
  const m1 = await member(h, 'M1');
  const m2 = await member(h, 'M2');
  const a1 = (await m1.post(`/api/teams/${o.team.id}/applications`)).body.application;
  const a2 = (await m2.post(`/api/teams/${o.team.id}/applications`)).body.application;
  assert.equal((await o.post(`/api/applications/${a1.id}/accept`)).status, 200);
  const full = await o.post(`/api/applications/${a2.id}/accept`);
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'TEAM_FULL');
  const m3 = await member(h, 'M3');
  assert.equal((await m3.post(`/api/teams/${o.team.id}/applications`)).body.error.code, 'TEAM_FULL');
  const list = await m3.get(`/api/hackathons/${h.id}/teams`);
  assert.equal(list.body.teams[0].isFull, true);
});

test('concurrent accepts never overfill a team', async () => {
  const h = await t.openHackathon(admin, { minTeamSize: 1, maxTeamSize: 3 });
  const o = await owner(h);
  const apps = [];
  for (let i = 0; i < 6; i++) {
    const m = await member(h, `Racer${i}`);
    apps.push((await m.post(`/api/teams/${o.team.id}/applications`)).body.application);
  }
  const results = await Promise.all(apps.map((a) => o.post(`/api/applications/${a.id}/accept`)));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'TEAM_FULL'));
  const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM team_members WHERE team_id = $1', [o.team.id]);
  assert.equal(rows[0].n, 3);
});

test('concurrent accepts by two teams place a member in exactly one', async () => {
  const h = await t.openHackathon(admin);
  const a = await owner(h, 'Left');
  const b = await owner(h, 'Right');
  const m = await member(h, 'Wanted');
  const appA = (await m.post(`/api/teams/${a.team.id}/applications`)).body.application;
  const appB = (await m.post(`/api/teams/${b.team.id}/applications`)).body.application;
  const [ra, rb] = await Promise.all([
    a.post(`/api/applications/${appA.id}/accept`),
    b.post(`/api/applications/${appB.id}/accept`),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM team_members WHERE user_id = $1', [m.user.id]);
  assert.equal(rows[0].n, 1);
});

test('the owner cannot leave or be removed; members can leave or be removed', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const m1 = await member(h, 'Stay');
  const m2 = await member(h, 'Go');
  for (const m of [m1, m2]) {
    const app = (await m.post(`/api/teams/${o.team.id}/applications`)).body.application;
    await o.post(`/api/applications/${app.id}/accept`);
  }
  const selfOwner = await o.del(`/api/teams/${o.team.id}/members/${o.user.id}`);
  assert.equal(selfOwner.body.error.code, 'OWNER_CANNOT_LEAVE');
  const byAdmin = await admin.del(`/api/teams/${o.team.id}/members/${o.user.id}`);
  assert.equal(byAdmin.body.error.code, 'OWNER_CANNOT_LEAVE');
  const kick = await m1.del(`/api/teams/${o.team.id}/members/${m2.user.id}`);
  assert.equal(kick.body.error.code, 'NOT_TEAM_OWNER');
  assert.equal((await m1.del(`/api/teams/${o.team.id}/members/${m1.user.id}`)).status, 204);
  assert.equal((await o.del(`/api/teams/${o.team.id}/members/${m2.user.id}`)).status, 204);
  const team = await o.get(`/api/teams/${o.team.id}`);
  assert.equal(team.body.members.length, 1);
});

test('roles lock once something depends on them', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const r1 = await o.patch(`/api/hackathons/${h.id}/registration`, { role: 'member' });
  assert.equal(r1.body.error.code, 'ROLE_LOCKED_IN_TEAM');
  const m = await member(h);
  await m.post(`/api/teams/${o.team.id}/applications`);
  const r2 = await m.patch(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  assert.equal(r2.body.error.code, 'ROLE_LOCKED_PENDING_APPLICATIONS');
  const free = await member(h, 'Free');
  const r3 = await free.patch(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.registration.role, 'idea_owner');
});

test('withdrawing needs leaving the team first', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const r = await o.del(`/api/hackathons/${h.id}/registration`);
  assert.equal(r.body.error.code, 'DISBAND_TEAM_FIRST');
  assert.equal((await o.del(`/api/teams/${o.team.id}`)).status, 204);
  assert.equal((await o.del(`/api/hackathons/${h.id}/registration`)).status, 204);
  const mine = await o.get(`/api/hackathons/${h.id}/me`);
  assert.equal(mine.body.registration, null);
  assert.equal(mine.body.idea, null);
});

test('owners cannot disband a team that has members; admins can', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const m = await member(h);
  const app = (await m.post(`/api/teams/${o.team.id}/applications`)).body.application;
  await o.post(`/api/applications/${app.id}/accept`);
  assert.equal((await o.del(`/api/teams/${o.team.id}`)).body.error.code, 'TEAM_HAS_MEMBERS');
  assert.equal((await o.post(`/api/ideas/${o.idea.id}/withdraw`)).body.error.code, 'IDEA_HAS_TEAM_MEMBERS');
  assert.equal((await admin.del(`/api/teams/${o.team.id}`)).status, 204);
  const mine = await m.get(`/api/hackathons/${h.id}/me`);
  assert.equal(mine.body.membership, null);
  assert.equal(mine.body.applications[0].status, 'removed');
});

test('closed teams take no applications; contact details stay inside the team', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const m = await member(h);
  await o.patch(`/api/teams/${o.team.id}`, { isOpen: false });
  assert.equal((await m.post(`/api/teams/${o.team.id}/applications`)).body.error.code, 'TEAM_CLOSED');
  const view = await m.get(`/api/teams/${o.team.id}`);
  assert.equal(view.body.insider, false);
  assert.equal(view.body.members[0].email, undefined);
  const inside = await o.get(`/api/teams/${o.team.id}`);
  assert.equal(inside.body.members[0].email, o.email);
});

test('closing the hackathon freezes team changes', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  const m = await member(h);
  const app = (await m.post(`/api/teams/${o.team.id}/applications`)).body.application;
  await admin.patch(`/api/hackathons/${h.id}`, { status: 'closed' });
  assert.equal((await o.post(`/api/applications/${app.id}/accept`)).body.error.code, 'TEAMING_CLOSED');
});

test('the admin participant overview joins registrations, ideas and teams', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h);
  await member(h);
  const r = await admin.get(`/api/hackathons/${h.id}/participants`);
  assert.equal(r.status, 200);
  assert.equal(r.body.participants.length, 2);
  const row = r.body.participants.find((p) => p.userId === o.user.id);
  assert.equal(row.teamRole, 'owner');
  assert.equal(row.ideaTitle, IDEA.title);
  assert.equal((await o.get(`/api/hackathons/${h.id}/participants`)).status, 403);
});
