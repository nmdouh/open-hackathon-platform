'use strict';

// Creates an administrator, or promotes an existing account.
//
//   npm run create-admin -- --email admin@example.org --name "Event Admin"
//
// The password is taken from ADMIN_PASSWORD; if it is not set, a strong one
// is generated and printed once.

require('../server/lib/env').loadDotEnv();
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { loadConfig } = require('../server/config');
const { createPool } = require('../server/db/pool');
const { migrate } = require('../server/db/migrate');
const { hashPassword } = require('../server/lib/password');

(async () => {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string', default: 'Administrator' } },
  });
  const email = String(values.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: npm run create-admin -- --email you@example.org [--name "Your Name"]');
    process.exit(2);
  }
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(15).toString('base64url');
  if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');

  const pool = createPool(loadConfig().databaseUrl);
  try {
    await migrate(pool);
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (lower(email)) DO UPDATE SET role = 'admin', is_active = true, password_hash = EXCLUDED.password_hash
       RETURNING id, (xmax = 0) AS inserted`,
      [email, values.name, hash],
    );
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES ($1, 'user.admin_created_by_cli', 'user', $1)`,
      [rows[0].id],
    );
    console.log(`${rows[0].inserted ? 'Created' : 'Promoted'} administrator ${email}.`);
    if (generated) console.log(`Generated password (shown once, change it after signing in): ${password}`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
