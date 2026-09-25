'use strict';

const { Pool } = require('pg');

function createPool(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env or export DATABASE_URL.');
  }
  return new Pool({ connectionString, max: 10 });
}

// Runs fn(client) inside a transaction. Serialization failures and deadlocks
// are retried a few times, because the participation rules rely on row locks.
async function tx(pool, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err && (err.code === '40001' || err.code === '40P01');
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { createPool, tx };
