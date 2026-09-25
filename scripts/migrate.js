'use strict';

require('../server/lib/env').loadDotEnv();
const { loadConfig } = require('../server/config');
const { createPool } = require('../server/db/pool');
const { migrate } = require('../server/db/migrate');

(async () => {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const ran = await migrate(pool, { log: (m) => console.log(m) });
    console.log(ran.length ? `Done: ${ran.length} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
