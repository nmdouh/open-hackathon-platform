'use strict';

const express = require('express');
const { z, parse, requiredText } = require('../../lib/http');
const { forbidden, unauthorized, badRequest, fromPg } = require('../../lib/errors');
const { hashPassword, verifyPassword, burnTime } = require('../../lib/password');
const { rateLimit } = require('../../lib/security');
const {
  createSession, destroySession, setSessionCookie, clearSessionCookie, requireUser, hashToken,
} = require('../../auth/sessions');
const { audit } = require('../../lib/audit');

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10).max(200);

const publicUser = (u) => ({
  id: u.id, email: u.email, displayName: u.display_name, role: u.role, locale: u.locale,
});

module.exports = function authRoutes({ pool, config }) {
  const r = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.authRateLimit,
    key: (req) => `${req.ip}|${String((req.body && req.body.email) || '').toLowerCase()}`,
  });
  const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: config.authRateLimit, key: (req) => req.ip });

  r.post('/signup', signupLimiter, async (req, res) => {
    if (!config.allowSignup) throw forbidden('SIGNUP_DISABLED', 'Self sign-up is disabled');
    const body = parse(z.object({
      email, password, displayName: requiredText(120), locale: z.enum(['en', 'ar']).default('en'),
    }), req.body);
    const hash = await hashPassword(body.password);
    let user;
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (email, display_name, password_hash, locale)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [body.email, body.displayName, hash, body.locale],
      );
      user = rows[0];
    } catch (err) { throw fromPg(err); }
    await audit(pool, { actorId: user.id, action: 'user.signup', entityType: 'user', entityId: user.id });
    const s = await createSession(pool, user.id, { ttlHours: config.sessionTtlHours, userAgent: req.get('user-agent') });
    setSessionCookie(res, config, s.token, s.expiresAt);
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [body.email]);
    const user = rows[0];
    const ok = user && user.is_active && user.password_hash
      ? await verifyPassword(body.password, user.password_hash)
      : await burnTime(body.password);
    if (!ok) throw unauthorized('BAD_CREDENTIALS', 'Email or password is incorrect');
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const s = await createSession(pool, user.id, { ttlHours: config.sessionTtlHours, userAgent: req.get('user-agent') });
    setSessionCookie(res, config, s.token, s.expiresAt);
    res.json({ user: publicUser(user) });
  });

  r.post('/logout', async (req, res) => {
    await destroySession(pool, req.sessionToken);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  r.patch('/me', requireUser, async (req, res) => {
    const body = parse(z.object({
      displayName: requiredText(120).optional(),
      locale: z.enum(['en', 'ar']).optional(),
    }), req.body);
    const { rows } = await pool.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), locale = COALESCE($3, locale)
       WHERE id = $1 RETURNING *`,
      [req.user.id, body.displayName ?? null, body.locale ?? null],
    );
    res.json({ user: publicUser(rows[0]) });
  });

  r.post('/password', requireUser, loginLimiter, async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }), req.body);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
      throw badRequest('BAD_CREDENTIALS', 'Current password is incorrect');
    }
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(body.newPassword)]);
    // Sign out every other session after a password change.
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, hashToken(req.sessionToken)]);
    await audit(pool, { actorId: req.user.id, action: 'user.password_changed', entityType: 'user', entityId: req.user.id });
    res.status(204).end();
  });

  return r;
};

module.exports.publicUser = publicUser;
