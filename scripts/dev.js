'use strict';

// Zero-setup development server. If DATABASE_URL is not set, a local
// PostgreSQL is started in ./.data/pg and kept between runs.
//
//   npm run dev
//   npm run dev -- --seed      (also creates a demo hackathon and accounts)

require('../server/lib/env').loadDotEnv();
const path = require('node:path');
const { startEmbeddedPostgres } = require('./embedded-pg');

(async () => {
  let embedded;
  if (!process.env.DATABASE_URL) {
    const port = Number(process.env.DEV_PG_PORT || 54329);
    console.log(`Starting embedded PostgreSQL on port ${port} (data in .data/pg) ...`);
    embedded = await startEmbeddedPostgres({
      dataDir: path.join(__dirname, '..', '.data', 'pg'), port, persistent: true,
    });
    await embedded.ensureDatabase('ohp');
    process.env.DATABASE_URL = embedded.url('ohp');
    const stop = async () => { await embedded.stop().catch(() => {}); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  if (!process.env.SETTINGS_SECRET) {
    // Development only: keep a random secret next to the local database so the
    // AI key saved from the admin page stays readable across restarts.
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const file = path.join(__dirname, '..', '.data', 'settings-secret');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
    process.env.SETTINGS_SECRET = fs.readFileSync(file, 'utf8').trim();
  }
  if (process.argv.includes('--seed')) {
    const { seedDemo } = require('./seed-demo');
    await seedDemo(process.env.DATABASE_URL);
  }
  require('../server/index.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
