'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

test('sign up creates a session with an httpOnly cookie', async () => {
  const c = t.client();
  const r = await c.post('/api/auth/signup', { email: 'Ana@Example.test', password: 'long enough pw', displayName: 'Ana' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.email, 'ana@example.test');
  assert.equal(r.body.user.role, 'user');
  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.user.displayName, 'Ana');
});

test('the database never stores the raw session token or password', async () => {
  const c = t.client();
  await c.post('/api/auth/signup', { email: 'raw@example.test', password: 'plain secret 99', displayName: 'Raw' });
  const { rows } = await t.pool.query("SELECT password_hash FROM users WHERE email = 'raw@example.test'");
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.ok(!rows[0].password_hash.includes('plain secret'));
  const { rows: s } = await t.pool.query('SELECT token_hash FROM sessions');
  assert.ok(s.every((x) => Buffer.isBuffer(x.token_hash) && x.token_hash.length === 32));
});

test('duplicate email is rejected regardless of case', async () => {
  const c = t.client();
  await c.post('/api/auth/signup', { email: 'dup@example.test', password: 'long enough pw', displayName: 'A' });
  const r = await t.client().post('/api/auth/signup', { email: 'DUP@example.test', password: 'long enough pw', displayName: 'B' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'EMAIL_TAKEN');
});

test('short passwords fail validation', async () => {
  const r = await t.client().post('/api/auth/signup', { email: 'short@example.test', password: 'short', displayName: 'S' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_FAILED');
});

test('login with wrong password fails; logout ends the session', async () => {
  const u = await t.user('Lee');
  const bad = await t.client().post('/api/auth/login', { email: u.email, password: 'wrong password' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'BAD_CREDENTIALS');
  const c = t.client();
  const ok = await c.post('/api/auth/login', { email: u.email, password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/auth/me')).body.user, null);
});

test('cross-origin and non-JSON mutations are refused', async () => {
  const u = await t.user('Csrf');
  const cross = await u.post('/api/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'BAD_ORIGIN');
  // A classic cross-site form post: urlencoded body, no Origin header.
  const form = await fetch(`${t.base}/api/auth/logout`, {
    method: 'POST', body: 'role=admin', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415);
});

test('administrator endpoints are closed to ordinary users', async () => {
  const u = await t.user('Plain');
  assert.equal((await u.get('/api/admin/users')).status, 403);
  assert.equal((await u.post('/api/hackathons', { slug: 'nope', titleEn: 'Nope' })).status, 403);
  assert.equal((await t.client().get('/api/admin/users')).status, 401);
});

test('the last administrator cannot be demoted or deactivated', async () => {
  const a = await t.adminUser();
  const { rows } = await t.pool.query("SELECT id FROM users WHERE role = 'admin'");
  for (const row of rows) {
    if (row.id !== a.user.id) await t.pool.query("UPDATE users SET role = 'user' WHERE id = $1", [row.id]);
  }
  const r = await a.patch(`/api/admin/users/${a.user.id}`, { role: 'user' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'LAST_ADMIN');
});

test('deactivating a user signs them out everywhere', async () => {
  const a = await t.adminUser();
  const u = await t.user('Gone');
  assert.equal((await a.patch(`/api/admin/users/${u.user.id}`, { isActive: false })).status, 200);
  assert.equal((await u.get('/api/auth/me')).body.user, null);
  const again = await t.client().post('/api/auth/login', { email: u.email, password: 'correct horse battery' });
  assert.equal(again.status, 401);
});

test('self sign-up can be switched off', async () => {
  const s = await startTestServer({ allowSignup: false });
  try {
    const r = await s.client().post('/api/auth/signup', { email: 'x@example.test', password: 'long enough pw', displayName: 'X' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'SIGNUP_DISABLED');
  } finally {
    await s.close();
  }
});

test('security headers are present', async () => {
  const r = await t.client().get('/api/health');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
