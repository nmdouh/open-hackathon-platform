'use strict';

// Starts one embedded PostgreSQL for the whole test run. Each test file then
// creates its own database (see helpers.js), so files never share state.
// Set TEST_DATABASE_ADMIN_URL to use an existing server instead.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startEmbeddedPostgres } = require('../scripts/embedded-pg');

let embedded;
let dataDir;

async function globalSetup() {
  if (process.env.TEST_DATABASE_ADMIN_URL) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohp-test-pg-'));
  const port = 55000 + Math.floor(Math.random() * 4000);
  embedded = await startEmbeddedPostgres({ dataDir, port, persistent: false });
  process.env.TEST_DATABASE_ADMIN_URL = embedded.url('postgres');
}

async function globalTeardown() {
  if (embedded) await embedded.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

module.exports = { globalSetup, globalTeardown };
