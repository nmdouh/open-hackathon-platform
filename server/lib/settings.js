'use strict';

const { encrypt, decrypt } = require('./secrets');
const { HttpError } = require('./errors');

// The AI coach configuration comes from the database once an administrator
// saves it, and from the LLM_* environment variables until then.
// Cached briefly per database pool so every request does not hit the table.
const cache = new WeakMap();
const TTL_MS = 30_000;

function fromEnvironment(config) {
  const { apiKey, ...rest } = config.llm;
  return {
    source: 'environment', enabled: true, ...rest, apiKey,
    apiKeyHint: apiKey ? apiKey.slice(-4) : '', apiKeyUnreadable: false,
  };
}

async function effectiveLlm(pool, config) {
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { rows } = await pool.query("SELECT value, updated_at FROM app_settings WHERE key = 'llm'");
  let value;
  if (rows[0]) {
    const s = rows[0].value;
    let apiKey = '';
    let unreadable = false;
    if (s.apiKey) {
      try { apiKey = decrypt(config.settingsSecret, s.apiKey); } catch { unreadable = true; }
    }
    value = {
      source: 'database', enabled: Boolean(s.enabled), endpoint: s.endpoint || '', model: s.model || '',
      apiKey, apiKeyHint: s.apiKeyHint || '', apiKeyUnreadable: unreadable,
      dailyLimit: s.dailyLimit, timeoutMs: s.timeoutMs, updatedAt: rows[0].updated_at,
    };
  } else {
    value = fromEnvironment(config);
  }
  cache.set(pool, { at: Date.now(), value });
  return value;
}

function invalidate(pool) {
  cache.delete(pool);
}

// What administrators may see: everything except the key itself.
function publicView(llm, config) {
  return {
    source: llm.source,
    enabled: llm.enabled,
    endpoint: llm.endpoint,
    model: llm.model,
    dailyLimit: llm.dailyLimit,
    timeoutMs: llm.timeoutMs,
    apiKeySet: Boolean(llm.apiKey) || llm.apiKeyUnreadable,
    apiKeyHint: llm.apiKeyHint,
    apiKeyUnreadable: llm.apiKeyUnreadable,
    canStoreKey: Boolean(config.settingsSecret),
    updatedAt: llm.updatedAt || null,
  };
}

// Saves new settings. apiKey: undefined keeps the stored key, '' removes it.
async function saveLlm(pool, config, userId, input) {
  const current = await effectiveLlm(pool, config);
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'llm'");
  const stored = rows[0] ? rows[0].value : null;
  let apiKeyBox = stored ? stored.apiKey || null : null;
  let apiKeyHint = stored ? stored.apiKeyHint || '' : '';
  if (input.apiKey !== undefined) {
    if (input.apiKey === '') {
      apiKeyBox = null;
      apiKeyHint = '';
    } else {
      if (!config.settingsSecret) {
        throw new HttpError(409, 'SETTINGS_SECRET_MISSING', 'Set SETTINGS_SECRET on the server to store an API key');
      }
      apiKeyBox = encrypt(config.settingsSecret, input.apiKey);
      apiKeyHint = input.apiKey.slice(-4);
    }
  } else if (!stored && current.apiKey && config.settingsSecret) {
    // First save from the admin page: carry over a key given by environment.
    apiKeyBox = encrypt(config.settingsSecret, current.apiKey);
    apiKeyHint = current.apiKey.slice(-4);
  }
  const value = {
    enabled: input.enabled,
    endpoint: input.endpoint,
    model: input.model,
    dailyLimit: input.dailyLimit,
    timeoutMs: input.timeoutMs,
    apiKey: apiKeyBox,
    apiKeyHint,
  };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('llm', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [value, userId],
  );
  invalidate(pool);
  return effectiveLlm(pool, config);
}

async function resetLlm(pool) {
  await pool.query("DELETE FROM app_settings WHERE key = 'llm'");
  invalidate(pool);
}

module.exports = { effectiveLlm, invalidate, publicView, saveLlm, resetLlm };
