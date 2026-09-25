'use strict';

const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

// A stand-in for an OpenAI-compatible endpoint that records what it receives.
let llm;
const seen = [];
function startFakeLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        const answer = 'Here you go:\n```json\n' + JSON.stringify({
          summary: 'Promising.',
          scores: [{ criterion: 'Impact', score: 42, reason: 'Numbers are thin.' }],
          strengths: ['Clear user'], improvements: ['Show a baseline'], judgeQuestions: ['Who pays?'],
        }) + '\n```';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let t;
let admin;
before(async () => {
  llm = await startFakeLlm();
  t = await startTestServer({
    llm: {
      endpoint: `http://127.0.0.1:${llm.address().port}/v1/chat/completions`,
      apiKey: 'test-key-not-real', model: 'test-model', timeoutMs: 5000, dailyLimit: 2,
    },
  });
  admin = await t.adminUser();
});
after(async () => {
  await t.close();
  llm.close();
});

async function team(h, name = 'Owner') {
  const o = await t.user(name);
  await o.post(`/api/hackathons/${h.id}/registration`, { role: 'idea_owner' });
  const idea = (await o.post(`/api/hackathons/${h.id}/ideas`, { title: name, problem: 'P', solution: 'S', submit: true })).body.idea;
  o.team = (await o.post(`/api/ideas/${idea.id}/team`, { name: `${name} team` })).body.team;
  return o;
}

test('public posts reach participants; team-only posts stay inside the team', async () => {
  const h = await t.openHackathon(admin);
  const a = await team(h, 'A');
  const b = await team(h, 'B');
  await a.post(`/api/teams/${a.team.id}/progress`, { body: 'Login works', kind: 'demo', linkUrl: 'https://example.org/demo' });
  await a.post(`/api/teams/${a.team.id}/progress`, { body: 'Internal note', visibility: 'team' });
  const bFeed = await b.get(`/api/hackathons/${h.id}/progress`);
  assert.deepEqual(bFeed.body.posts.map((p) => p.body), ['Login works']);
  const aFeed = await a.get(`/api/hackathons/${h.id}/progress`);
  assert.equal(aFeed.body.posts.length, 2);
  assert.equal((await b.post(`/api/teams/${a.team.id}/progress`, { body: 'Not my team' })).status, 403);
  const outsider = await t.user('Out');
  assert.equal((await outsider.get(`/api/hackathons/${h.id}/progress`)).status, 403);
  const js = await a.post(`/api/teams/${a.team.id}/progress`, { body: 'x', linkUrl: 'javascript:alert(1)' });
  assert.equal(js.status, 400);
});

test('help requests get replies from other teams and can be resolved by the team', async () => {
  const h = await t.openHackathon(admin);
  const a = await team(h, 'Asker');
  const b = await team(h, 'Helper');
  const post = (await a.post(`/api/teams/${a.team.id}/progress`, { kind: 'help', body: 'Need a designer for an hour' })).body.post;
  assert.equal((await b.post(`/api/progress/${post.id}/replies`, { body: 'I can help at 3pm' })).status, 201);
  const rs = await a.get(`/api/progress/${post.id}/replies`);
  assert.equal(rs.body.replies[0].body, 'I can help at 3pm');
  assert.equal((await b.post(`/api/progress/${post.id}/resolve`, {})).status, 403);
  assert.equal((await a.post(`/api/progress/${post.id}/resolve`, {})).body.post.resolved, true);
  const hidden = (await a.post(`/api/teams/${a.team.id}/progress`, { body: 'secret', visibility: 'team' })).body.post;
  assert.equal((await b.get(`/api/progress/${hidden.id}/replies`)).status, 404);
});

test('pulse flags quiet teams for organisers and mentors only', async () => {
  const h = await t.openHackathon(admin);
  const active = await team(h, 'Busy');
  const quiet = await team(h, 'Silent');
  await active.post(`/api/teams/${active.team.id}/progress`, { body: 'Day 1 done' });
  await t.pool.query("UPDATE teams SET created_at = now() - interval '3 days' WHERE id = ANY($1)", [[active.team.id, quiet.team.id]]);
  assert.equal((await active.get(`/api/hackathons/${h.id}/pulse`)).status, 403);
  const p = await admin.get(`/api/hackathons/${h.id}/pulse`);
  const by = Object.fromEntries(p.body.teams.map((x) => [x.id, x]));
  assert.equal(by[quiet.team.id].quiet, true);
  assert.equal(by[active.team.id].quiet, false);
  assert.equal(by[active.team.id].postsTotal, 1);
  assert.equal(p.body.daily.length, 14);
});

test('resources: admins add, everyone in the event reads', async () => {
  const h = await t.openHackathon(admin);
  const bad = await admin.post(`/api/hackathons/${h.id}/resources`, { titleEn: 'x', url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  await admin.post(`/api/hackathons/${h.id}/resources`, { titleEn: 'Pitch guide', url: 'https://example.org/pitch', category: 'guide' });
  const u = await t.user('Reader');
  const list = await u.get(`/api/hackathons/${h.id}/resources`);
  assert.ok(list.body.resources.some((r) => r.titleEn === 'Pitch guide'));
  assert.equal((await u.post(`/api/hackathons/${h.id}/resources`, { titleEn: 'x', url: 'https://x.org' })).status, 403);
});

test('AI coach proxies to the configured model, clamps scores and enforces the daily limit', async () => {
  const h = await t.openHackathon(admin);
  const o = await team(h, 'Coached');
  const text = 'Our clinic triage assistant cuts waiting times by routing patients to the right desk on arrival.';
  const r = await o.post(`/api/hackathons/${h.id}/coach`, { mode: 'pitch', text, locale: 'ar' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.feedback.summary, 'Promising.');
  assert.equal(r.body.feedback.scores[0].score, 10, 'out-of-range score is clamped to the rubric maximum');
  const call = seen.at(-1);
  assert.equal(call.auth, 'Bearer test-key-not-real');
  assert.equal(call.body.model, 'test-model');
  assert.match(call.body.messages[0].content, /Arabic/);
  assert.match(call.body.messages[1].content, /<submission>/);
  // The key must never be exposed to the browser.
  const cfg = await o.get('/api/config');
  assert.equal(cfg.body.aiEnabled, true);
  assert.ok(!JSON.stringify(cfg.body).includes('test-key'));
  await o.post(`/api/hackathons/${h.id}/coach`, { mode: 'idea', text });
  const third = await o.post(`/api/hackathons/${h.id}/coach`, { mode: 'idea', text });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'AI_DAILY_LIMIT');
  const { rows } = await t.pool.query('SELECT * FROM ai_usage WHERE user_id = $1', [o.user.id]);
  assert.equal(rows.length, 2);
  assert.ok(!('prompt' in rows[0]));
});

test('AI coach reports clearly when it is not configured', async () => {
  const s = await startTestServer();
  try {
    const a = await s.adminUser();
    const h = await s.openHackathon(a);
    const u = await s.user('NoAi');
    await u.post(`/api/hackathons/${h.id}/registration`, { role: 'member' });
    const r = await u.post(`/api/hackathons/${h.id}/coach`, { mode: 'idea', text: 'x'.repeat(60) });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED');
  } finally {
    await s.close();
  }
});
