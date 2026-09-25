'use strict';

// All runtime configuration comes from environment variables so that no
// secret ever lives in the repository. See .env.example for the full list.

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    production,
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || '',
    appName: env.APP_NAME || 'Open Hackathon Platform',
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    cookieSecure: bool(env.COOKIE_SECURE, production),
    trustProxy: int(env.TRUST_PROXY, 0),
    // Attempts per IP (and per email for sign-in) before HTTP 429.
    authRateLimit: int(env.AUTH_RATE_LIMIT, 20),
    // Optional AI assistant (OpenAI-compatible chat completions endpoint).
    // The key is only ever read on the server and never sent to browsers.
    llm: {
      endpoint: env.LLM_ENDPOINT || '',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || '',
      timeoutMs: int(env.LLM_TIMEOUT_MS, 45000),
      // AI coach calls allowed per person per 24 hours.
      dailyLimit: int(env.LLM_DAILY_LIMIT, 20),
    },
  };
}

module.exports = { loadConfig };
