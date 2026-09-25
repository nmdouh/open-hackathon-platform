'use strict';

// Starts a throw-away local PostgreSQL for development and tests, using the
// `embedded-postgres` dev dependency. Production uses a real DATABASE_URL.

const fs = require('node:fs');
const path = require('node:path');

async function startEmbeddedPostgres({ dataDir, port, persistent }) {
  let EmbeddedPostgres;
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default;
  } catch {
    throw new Error('embedded-postgres is not installed. Run "npm install" (dev dependencies) or set DATABASE_URL.');
  }
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'ohp',
    password: 'ohp',
    port,
    persistent,
    // Arabic and other scripts need UTF-8; Windows would otherwise pick WIN1252.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });
  if (fresh) await pg.initialise();
  await pg.start();
  return {
    pg,
    url: (db) => `postgres://ohp:ohp@127.0.0.1:${port}/${db}`,
    async ensureDatabase(name) {
      const client = pg.getPgClient();
      await client.connect();
      try {
        const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (!rows.length) await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
      } finally {
        await client.end();
      }
    },
    stop: () => pg.stop(),
  };
}

module.exports = { startEmbeddedPostgres };
