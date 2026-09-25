'use strict';

require('./lib/env').loadDotEnv();
const { loadConfig } = require('./config');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool, { log: (m) => console.log(`[migrate] ${m}`) });
  const app = createApp({ pool, config });
  const server = app.listen(config.port, () => {
    console.log(`${config.appName} listening on http://localhost:${config.port}`);
  });
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
