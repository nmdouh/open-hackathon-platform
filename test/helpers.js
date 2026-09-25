'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');
const { createPool } = require('../server/db/pool');
const { migrate } = require('../server/db/migrate');
const { createApp } = require('../server/app');
const { loadConfig } = require('../server/config');
const { hashPassword } = require('../server/lib/password');

// Creates a fresh database, runs migrations and starts the app on a random
// port. Returns helpers for making authenticated API calls.
async function startTestServer(overrides = {}) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL missing: run tests with "npm test".');
  const dbName = `ohp_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} ENCODING 'UTF8' TEMPLATE template0`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  const config = { ...loadConfig({}), authRateLimit: 10_000, ...overrides };
  const app = createApp({ pool, config, logger: { error: (...a) => console.error(...a) } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // A tiny cookie-aware client per user.
  function client() {
    let cookie = '';
    async function call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const set = res.headers.getSetCookie();
      for (const c of set) {
        const pair = c.split(';')[0];
        cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    }
    return {
      get: (p, h) => call('GET', p, undefined, h),
      post: (p, b = {}, h) => call('POST', p, b, h),
      patch: (p, b = {}, h) => call('PATCH', p, b, h),
      del: (p, h) => call('DELETE', p, undefined, h),
      raw: call,
    };
  }

  let seq = 0;
  // Signs up a new user and returns a logged-in client with .user set.
  async function user(name = 'User') {
    seq += 1;
    const c = client();
    const email = `${name.toLowerCase().replace(/\W+/g, '')}${seq}@example.test`;
    const r = await c.post('/api/auth/signup', { email, password: 'correct horse battery', displayName: `${name} ${seq}` });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    c.user = r.body.user;
    c.email = email;
    return c;
  }

  async function adminUser() {
    seq += 1;
    const email = `admin${seq}@example.test`;
    await pool.query(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')",
      [email, await hashPassword('admin password 123')],
    );
    const c = client();
    const r = await c.post('/api/auth/login', { email, password: 'admin password 123' });
    if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.body)}`);
    c.user = r.body.user;
    return c;
  }

  // Creates an open hackathon through the API and returns it.
  async function openHackathon(adminClient, fields = {}) {
    seq += 1;
    const r = await adminClient.post('/api/hackathons', {
      slug: `event-${seq}`, titleEn: `Event ${seq}`, titleAr: `فعالية ${seq}`, status: 'open', ...fields,
    });
    if (r.status !== 201) throw new Error(`create hackathon failed: ${JSON.stringify(r.body)}`);
    return r.body.hackathon;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  }

  return { base, pool, config, client, user, adminUser, openHackathon, close };
}

module.exports = { startTestServer };
