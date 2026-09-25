'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads KEY=value lines from .env into process.env without overriding
// variables that are already set. Real deployments should set variables in
// their process manager or container platform instead.
function loadDotEnv(file = path.join(__dirname, '..', '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

module.exports = { loadDotEnv };
