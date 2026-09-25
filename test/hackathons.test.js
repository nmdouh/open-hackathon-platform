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

test('drafts are hidden from participants until opened', async () => {
  const r = await admin.post('/api/hackathons', { slug: 'spring-draft', titleEn: 'Spring' });
  assert.equal(r.status, 201);
  assert.equal(r.body.hackathon.status, 'draft');
  const u = await t.user('Viewer');
  assert.equal((await u.get('/api/hackathons/spring-draft')).status, 404);
  assert.ok(!(await u.get('/api/hackathons')).body.hackathons.some((h) => h.slug === 'spring-draft'));
  await admin.patch(`/api/hackathons/${r.body.hackathon.id}`, { status: 'open' });
  const seen = await u.get('/api/hackathons/spring-draft');
  assert.equal(seen.status, 200);
  assert.equal(seen.body.hackathon.registrationOpen, true);
});

test('slugs are unique and validated', async () => {
  await admin.post('/api/hackathons', { slug: 'unique-one', titleEn: 'A' });
  const dup = await admin.post('/api/hackathons', { slug: 'unique-one', titleEn: 'B' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'SLUG_TAKEN');
  const bad = await admin.post('/api/hackathons', { slug: 'Bad Slug!', titleEn: 'C' });
  assert.equal(bad.status, 400);
});

test('team size range is enforced by the database too', async () => {
  const h = await t.openHackathon(admin);
  const r = await admin.patch(`/api/hackathons/${h.id}`, { minTeamSize: 9, maxTeamSize: 3 });
  assert.equal(r.status, 400);
});

test('tracks, stages and announcements', async () => {
  const h = await t.openHackathon(admin);
  const track = await admin.post(`/api/hackathons/${h.id}/tracks`, { nameEn: 'Health', nameAr: 'الصحة' });
  assert.equal(track.status, 201);
  const stage = await admin.post(`/api/hackathons/${h.id}/stages`, {
    nameEn: 'Build', startsAt: '2026-10-01T08:00:00Z', endsAt: '2026-10-10T17:00:00Z',
  });
  assert.equal(stage.status, 201);
  const backwards = await admin.post(`/api/hackathons/${h.id}/stages`, {
    nameEn: 'Oops', startsAt: '2026-10-10T08:00:00Z', endsAt: '2026-10-01T17:00:00Z',
  });
  assert.equal(backwards.status, 400);
  await admin.post(`/api/hackathons/${h.id}/announcements`, { titleEn: 'Welcome', bodyEn: 'Hello', pinned: true });
  const detail = await (await t.user('Reader')).get(`/api/hackathons/${h.slug}`);
  assert.equal(detail.body.tracks[0].nameAr, 'الصحة');
  assert.equal(detail.body.stages.length, 1);
  const ann = await admin.get(`/api/hackathons/${h.id}/announcements`);
  assert.equal(ann.body.announcements[0].titleEn, 'Welcome');
});

test('changes are written to the audit log', async () => {
  const h = await t.openHackathon(admin);
  await admin.patch(`/api/hackathons/${h.id}`, { status: 'running' });
  const log = await admin.get(`/api/admin/audit?hackathonId=${h.id}`);
  const actions = log.body.entries.map((e) => e.action);
  assert.ok(actions.includes('hackathon.created'));
  const upd = log.body.entries.find((e) => e.action === 'hackathon.updated');
  assert.equal(upd.details.statusTo, 'running');
  assert.equal(upd.actorId, admin.user.id);
});

test('registration windows are respected', async () => {
  const past = await t.openHackathon(admin, { registrationClosesAt: '2020-01-01T00:00:00Z' });
  const u = await t.user('Late');
  const r = await u.post(`/api/hackathons/${past.id}/registration`, { role: 'member' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'REGISTRATION_CLOSED');
});
