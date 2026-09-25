'use strict';

const { forbidden, HttpError } = require('./errors');

// Conservative headers for an app that serves its own static UI and a JSON API.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence for cookie-authenticated mutations: the request must be JSON
// (which a cross-site HTML form cannot send without a CORS preflight) and,
// when the browser sends Origin, it must match this host.
function csrfGuard(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) return next(forbidden('BAD_ORIGIN', 'Cross-origin request refused'));
  }
  const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
  if (hasBody && !req.is('application/json')) {
    return next(new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json'));
  }
  next();
}

// Small in-memory fixed-window limiter. Good enough for a single instance;
// put a reverse-proxy limiter in front when running several instances.
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts, try again later'));
    }
    next();
  };
}

module.exports = { securityHeaders, csrfGuard, rateLimit };
