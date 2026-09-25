'use strict';

const crypto = require('node:crypto');
const { unauthorized, forbidden } = require('../lib/errors');

const COOKIE = 'ohp_session';

// The browser holds a random token; the database stores only its SHA-256, so
// a leaked database dump cannot be replayed as live sessions.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

async function createSession(db, userId, { ttlHours, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4)
     RETURNING expires_at`,
    [hashToken(token), userId, ttlHours, (userAgent || '').slice(0, 300)],
  );
  return { token, expiresAt: rows[0].expires_at };
}

async function destroySession(db, token) {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, config, token, expiresAt) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

// Attaches req.user (or null) from the session cookie on every request.
function loadUser(pool) {
  return async (req, _res, next) => {
    req.user = null;
    req.sessionToken = readCookie(req, COOKIE);
    if (!req.sessionToken) return next();
    const { rows } = await pool.query(
      `UPDATE sessions s SET last_seen_at = now()
         FROM users u
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.is_active
      RETURNING u.id, u.email, u.display_name, u.role, u.locale`,
      [hashToken(req.sessionToken)],
    );
    req.user = rows[0] || null;
    next();
  };
}

function requireUser(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('ADMIN_ONLY', 'Administrators only'));
  next();
}

const isAdmin = (user) => Boolean(user && user.role === 'admin');

module.exports = {
  COOKIE, createSession, destroySession, setSessionCookie, clearSessionCookie,
  loadUser, requireUser, requireAdmin, isAdmin, hashToken,
};
