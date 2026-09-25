'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { scoreSkills } = require('../server/modules/engagement/matching');

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await t.adminUser();
});
after(async () => { await t.close(); });

async function owner(h, name, lookingFor, idea = {}) {
  const o = await t.user(name);
  await o.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  o.idea = (await o.post(`/api/hackathons/${h.id}/ideas`, { title: `${name} idea`, problem: 'P', solution: 'S', submit: true, ...idea })).body.idea;
  o.team = (await o.post(`/api/ideas/${o.idea.id}/team`, { name: `${name} team`, lookingFor })).body.team;
  return o;
}
async function member(h, name, skills) {
  const m = await t.user(name);
  await m.post(`/api/hackathons/${h.id}/registration`, { role: 'member', skills });
  return m;
}
const unread = async (c) => (await c.get('/api/notifications/unread')).body.unread;

test('skill matching explains itself and understands Arabic articles', () => {
  const r = scoreSkills(['Python', 'UX design', 'Cooking'], { lookingFor: 'We need Python and UX design help', context: '' });
  assert.equal(r.score, 6);
  assert.deepEqual(r.matched, ['Python', 'UX design']);
  const ar = scoreSkills(['تحليل البيانات'], { lookingFor: 'نبحث عن تحليل للبيانات', context: '' });
  assert.ok(ar.score > 0);
});

test('members get teams ranked by skill match; owners get people to invite', async () => {
  const h = await t.openHackathon(admin);
  const data = await owner(h, 'Data', 'python, data analysis');
  await owner(h, 'Design', 'ux design, research');
  const m = await member(h, 'Analyst', ['Python', 'data analysis']);
  const mine = await m.get(`/api/hackathons/${h.id}/matches`);
  assert.equal(mine.body.mode, 'teams');
  assert.equal(mine.body.teams[0].id, data.team.id);
  assert.deepEqual(mine.body.teams[0].matched, ['Python', 'data analysis']);

  await member(h, 'Painter', ['watercolour']);
  const people = await data.get(`/api/hackathons/${h.id}/matches`);
  assert.equal(people.body.mode, 'people');
  assert.equal(people.body.people[0].userId, m.user.id);
  assert.ok(!('email' in people.body.people[0]), 'suggestions do not expose emails');
});

test('invitations: the invitee accepts, the owner is notified, rules still apply', async () => {
  const h = await t.openHackathon(admin, { minTeamSize: 1, maxTeamSize: 2 });
  const o = await owner(h, 'Inviter', 'backend');
  const m = await member(h, 'Invitee', ['backend']);
  const other = await member(h, 'Other', ['backend']);

  const stranger = await t.user('Stranger');
  assert.equal((await stranger.post(`/api/teams/${o.team.id}/invitations`, { userId: m.user.id })).status, 403);
  const owner2 = await owner(h, 'SecondOwner', '');
  assert.equal((await o.post(`/api/teams/${o.team.id}/invitations`, { userId: owner2.user.id })).body.error.code, 'INVITEE_NOT_ELIGIBLE');

  const inv = (await o.post(`/api/teams/${o.team.id}/invitations`, { userId: m.user.id, message: 'Join us!' })).body.invitation;
  assert.equal(inv.direction, 'invite');
  assert.equal((await o.post(`/api/teams/${o.team.id}/invitations`, { userId: m.user.id })).body.error.code, 'DUPLICATE_APPLICATION');
  assert.equal(await unread(m), 1);
  // Only the invitee answers an invitation.
  assert.equal((await o.post(`/api/applications/${inv.id}/accept`)).body.error.code, 'NOT_YOUR_INVITATION');
  const invOther = (await o.post(`/api/teams/${o.team.id}/invitations`, { userId: other.user.id })).body.invitation;
  const ok = await m.post(`/api/applications/${inv.id}/accept`);
  assert.equal(ok.status, 200);
  assert.equal((await m.get(`/api/hackathons/${h.id}/me`)).body.membership.teamId, o.team.id);
  const note = (await o.get('/api/notifications')).body.notifications[0];
  assert.equal(note.kind, 'invitation.accepted');
  assert.equal(note.data.personName, m.user.displayName);
  // The team is now full, so the second invitation can no longer be accepted.
  assert.equal((await other.post(`/api/applications/${invOther.id}/accept`)).body.error.code, 'TEAM_FULL');
});

test('invitations do not use up the applicant cap, and teams can withdraw them', async () => {
  const h = await t.openHackathon(admin, { maxPendingApplications: 1 });
  const a = await owner(h, 'A', '');
  const b = await owner(h, 'B', '');
  const m = await member(h, 'Busy', []);
  const inv = (await a.post(`/api/teams/${a.team.id}/invitations`, { userId: m.user.id })).body.invitation;
  assert.equal((await m.post(`/api/teams/${b.team.id}/applications`)).status, 201);
  assert.equal((await m.post(`/api/applications/${inv.id}/withdraw`)).body.error.code, 'NOT_TEAM_OWNER');
  assert.equal((await a.post(`/api/applications/${inv.id}/withdraw`)).body.application.status, 'withdrawn');
});

test('notifications: applications, decisions, announcements; read state', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h, 'Owner', '');
  const m = await member(h, 'Applicant', []);
  const app = (await m.post(`/api/teams/${o.team.id}/applications`, { message: 'hi' })).body.application;
  const got = (await o.get('/api/notifications')).body;
  assert.equal(got.notifications[0].kind, 'application.received');
  assert.equal(got.notifications[0].link, `h/${h.slug}/teams/${o.team.id}`);
  await o.post(`/api/applications/${app.id}/reject`);
  assert.equal((await m.get('/api/notifications')).body.notifications[0].kind, 'application.rejected');
  await admin.post(`/api/hackathons/${h.id}/announcements`, { titleEn: 'Doors open at 9', titleAr: 'تفتح الأبواب 9' });
  const list = (await m.get('/api/notifications')).body;
  assert.equal(list.notifications[0].kind, 'announcement');
  assert.equal(list.notifications[0].data.titleAr, 'تفتح الأبواب 9');
  assert.equal(list.unread, 2);
  assert.equal((await m.post('/api/notifications/read', { ids: [list.notifications[0].id] })).body.unread, 1);
  assert.equal((await m.post('/api/notifications/read', { all: true })).body.unread, 0);
  // People never see someone else's notifications.
  assert.equal((await o.post('/api/notifications/read', { ids: [list.notifications[1].id] })).body.unread, (await unread(o)));
  assert.equal(await unread(m), 0);
});

test('milestones: template, team checklist, evidence, mentor notified, progress in listings', async () => {
  const h = await t.openHackathon(admin);
  const o = await owner(h, 'Builder', '');
  const outsiderOwner = await owner(h, 'Other', '');
  assert.equal((await o.post(`/api/hackathons/${h.id}/milestones/template`)).status, 403);
  const tpl = await admin.post(`/api/hackathons/${h.id}/milestones/template`);
  assert.equal(tpl.status, 201);
  assert.equal(tpl.body.milestones.length, 6);
  assert.equal((await admin.post(`/api/hackathons/${h.id}/milestones/template`)).body.error.code, 'MILESTONES_EXIST');

  const mentor = await t.user('Coach');
  await admin.post(`/api/hackathons/${h.id}/mentors`, { userId: mentor.user.id });
  await admin.raw('PUT', `/api/teams/${o.team.id}/mentors/${mentor.user.id}`);
  const before = await unread(mentor);

  const ms = tpl.body.milestones[0];
  assert.equal((await outsiderOwner.raw('PUT', `/api/teams/${o.team.id}/milestones/${ms.id}`, { done: true })).status, 403);
  const bad = await o.raw('PUT', `/api/teams/${o.team.id}/milestones/${ms.id}`, { done: true, evidenceUrl: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  assert.equal((await o.raw('PUT', `/api/teams/${o.team.id}/milestones/${ms.id}`, { done: true, evidenceUrl: 'https://example.org/notes' })).status, 204);
  assert.equal(await unread(mentor), before + 1);

  const list = await o.get(`/api/teams/${o.team.id}/milestones`);
  assert.equal(list.body.canEdit, true);
  assert.equal(list.body.milestones[0].evidenceUrl, 'https://example.org/notes');
  assert.equal((await outsiderOwner.get(`/api/teams/${o.team.id}/milestones`)).body.canEdit, false);
  const teams = await mentor.get(`/api/hackathons/${h.id}/teams`);
  assert.equal(teams.status, 200, 'mentors can browse teams');
  const row = teams.body.teams.find((x) => x.id === o.team.id);
  assert.equal(row.milestonesDone, 1);
  assert.equal(row.milestonesTotal, 6);
  await o.raw('PUT', `/api/teams/${o.team.id}/milestones/${ms.id}`, { done: false });
  assert.equal((await o.get(`/api/teams/${o.team.id}/milestones`)).body.milestones[0].doneAt, null);
});

test('public stats and the organiser dashboard', async () => {
  const h = await t.openHackathon(admin, { minTeamSize: 3, maxTeamSize: 4 });
  const o = await owner(h, 'Solo', 'anything');
  await member(h, 'Waiting', []);
  const s = await t.client().get(`/api/hackathons/${h.id}/stats`);
  assert.equal(s.status, 200);
  assert.equal(s.body.stats.participants, 2);
  assert.equal(s.body.stats.teams, 1);
  assert.equal(s.body.stats.openSpots, 3);
  assert.equal(s.body.stats.lookingForTeam, 1);
  assert.equal((await o.get(`/api/hackathons/${h.id}/dashboard`)).status, 403);
  const d = await admin.get(`/api/hackathons/${h.id}/dashboard`);
  assert.equal(d.body.funnel.registered, 2);
  assert.equal(d.body.funnel.ideasSubmitted, 1);
  assert.equal(d.body.funnel.teamsReady, 0);
  assert.deepEqual(d.body.atRisk[0].reasons, ['understaffed', 'no_mentor']);
});
