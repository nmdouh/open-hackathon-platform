'use strict';

const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const SECRET_KEY = 'sk-test-abcdef123456-wxyz';
let llm;
const seen = [];

// Fake OpenAI-compatible endpoint that only accepts the expected key.
function startFakeLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        if (req.headers.authorization !== `Bearer ${SECRET_KEY}`) {
          res.statusCode = 401;
          return res.end('{}');
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"Looks good.","scores":[],"strengths":[],"improvements":[],"judgeQuestions":[]}' } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let t;
let admin;
let endpoint;
before(async () => {
  llm = await startFakeLlm();
  endpoint = `http://127.0.0.1:${llm.address().port}/v1/chat/completions`;
  t = await startTestServer({ settingsSecret: 'unit-test-settings-secret' });
  admin = await t.adminUser();
});
after(async () => {
  await t.close();
  llm.close();
});

const settings = (extra = {}) => ({ enabled: true, endpoint, model: 'demo-model', dailyLimit: 5, timeoutMs: 10000, ...extra });

test('the coach starts off, and only administrators can configure it', async () => {
  const u = await t.user('Plain');
  assert.equal((await u.get('/api/config')).body.aiEnabled, false);
  assert.equal((await u.get('/api/admin/settings/llm')).status, 403);
  assert.equal((await u.raw('PUT', '/api/admin/settings/llm', settings({ apiKey: 'x' }))).status, 403);
  const s = await admin.get('/api/admin/settings/llm');
  assert.equal(s.body.llm.source, 'environment');
  assert.equal(s.body.llm.canStoreKey, true);
});

test('saving settings turns the coach on; the key is encrypted and never returned', async () => {
  const incomplete = await admin.raw('PUT', '/api/admin/settings/llm', settings({ model: '' }));
  assert.equal(incomplete.body.error.code, 'AI_SETTINGS_INCOMPLETE');
  const badUrl = await admin.raw('PUT', '/api/admin/settings/llm', settings({ endpoint: 'file:///etc/passwd' }));
  assert.equal(badUrl.status, 400);

  const r = await admin.raw('PUT', '/api/admin/settings/llm', settings({ apiKey: SECRET_KEY }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.llm.source, 'database');
  assert.equal(r.body.llm.apiKeySet, true);
  assert.equal(r.body.llm.apiKeyHint, 'wxyz');
  assert.ok(!JSON.stringify(r.body).includes(SECRET_KEY));
  assert.ok(!JSON.stringify((await admin.get('/api/admin/settings/llm')).body).includes(SECRET_KEY));

  const { rows } = await t.pool.query("SELECT value::text AS v FROM app_settings WHERE key = 'llm'");
  assert.ok(!rows[0].v.includes(SECRET_KEY), 'key must be encrypted at rest');
  const log = await admin.get('/api/admin/audit');
  assert.ok(!JSON.stringify(log.body).includes(SECRET_KEY), 'key must not appear in the audit log');
  assert.equal(log.body.entries.find((e) => e.action === 'settings.llm_updated').details.apiKey, 'replaced');

  const u = await t.user('Viewer');
  const cfg = await u.get('/api/config');
  assert.equal(cfg.body.aiEnabled, true);
  assert.ok(!JSON.stringify(cfg.body).includes(SECRET_KEY));
});

test('test connection uses the stored key', async () => {
  const r = await admin.post('/api/admin/settings/llm/test');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(seen.at(-1).auth, `Bearer ${SECRET_KEY}`);
  assert.equal(seen.at(-1).body.model, 'demo-model');
});

test('participants use the admin-configured model; saving without a key keeps the stored one', async () => {
  await admin.raw('PUT', '/api/admin/settings/llm', settings({ model: 'second-model', dailyLimit: 1 }));
  const h = await t.openHackathon(admin);
  const m = await t.user('Coachee');
  await m.post(`/api/hackathons/${h.id}/registration`, { role: 'member' });
  const text = 'We help residents book appointments in two taps instead of a twenty-minute phone call.';
  const r = await m.post(`/api/hackathons/${h.id}/coach`, { mode: 'idea', text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.feedback.summary, 'Looks good.');
  assert.equal(seen.at(-1).auth, `Bearer ${SECRET_KEY}`);
  assert.equal(seen.at(-1).body.model, 'second-model');
  const again = await m.post(`/api/hackathons/${h.id}/coach`, { mode: 'idea', text });
  assert.equal(again.body.error.code, 'AI_DAILY_LIMIT');
});

test('a wrong key is reported clearly; disabling and resetting work', async () => {
  await admin.raw('PUT', '/api/admin/settings/llm', settings({ apiKey: 'sk-wrong' }));
  const bad = await admin.post('/api/admin/settings/llm/test');
  assert.equal(bad.body.error.code, 'AI_AUTH_FAILED');
  await admin.raw('PUT', '/api/admin/settings/llm', settings({ enabled: false, apiKey: '' }));
  const off = await admin.get('/api/admin/settings/llm');
  assert.equal(off.body.llm.enabled, false);
  assert.equal(off.body.llm.apiKeySet, false);
  assert.equal((await admin.get('/api/config')).body.aiEnabled, false);
  const reset = await admin.del('/api/admin/settings/llm');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.llm.source, 'environment');
});

test('without SETTINGS_SECRET the key cannot be stored', async () => {
  const s = await startTestServer({ settingsSecret: '' });
  try {
    const a = await s.adminUser();
    assert.equal((await a.get('/api/admin/settings/llm')).body.llm.canStoreKey, false);
    const r = await a.raw('PUT', '/api/admin/settings/llm', settings({ apiKey: SECRET_KEY }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'SETTINGS_SECRET_MISSING');
    // A keyless endpoint (e.g. a local model) can still be configured.
    assert.equal((await a.raw('PUT', '/api/admin/settings/llm', settings())).status, 200);
  } finally {
    await s.close();
  }
});
