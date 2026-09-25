'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Arbitrary constant so that two instances starting at once do not race.
const LOCK_KEY = 804_221_117;

async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    const { rows: enc } = await client.query('SHOW server_encoding');
    if (enc[0].server_encoding !== 'UTF8') {
      throw new Error(`Database encoding is ${enc[0].server_encoding}; it must be UTF8 to store Arabic and other scripts. `
        + "Create it with: CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0;");
    }
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
      log(`applied ${file}`);
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };
