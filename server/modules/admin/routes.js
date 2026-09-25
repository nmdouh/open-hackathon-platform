'use strict';

const express = require('express');
const { z, parse, uuid, idParam } = require('../../lib/http');
const { requireAdmin } = require('../../auth/sessions');
const { conflict, notFound, HttpError } = require('../../lib/errors');
const { audit } = require('../../lib/audit');
const { toApi } = require('../../lib/shape');
const { tx } = require('../../db/pool');
const { effectiveLlm, publicView, saveLlm, resetLlm } = require('../../lib/settings');
const { chat, llmEnabled } = require('../../lib/llm');

const llmSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.union([
    z.string().trim().max(500).regex(/^https?:\/\/[^\s]+$/i, 'Must be an http(s) URL'),
    z.literal(''),
  ]),
  model: z.string().trim().max(200),
  // undefined keeps the stored key, '' removes it.
  apiKey: z.string().trim().max(1000).optional(),
  dailyLimit: z.number().int().min(1).max(1000),
  timeoutMs: z.number().int().min(5000).max(180000),
});

module.exports = function adminRoutes({ pool, config }) {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/users', async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(120).optional() }), req.query);
    const { rows } = await pool.query(
      `SELECT id, email, display_name, role, is_active, locale, created_at, last_login_at
         FROM users
        WHERE $1::text IS NULL OR email ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%'
        ORDER BY created_at DESC LIMIT 200`,
      [q.q || null],
    );
    res.json({ users: toApi(rows) });
  });

  r.patch('/users/:id', async (req, res) => {
    const id = idParam(req);
    const b = parse(z.object({ role: z.enum(['user', 'admin']).optional(), isActive: z.boolean().optional() }), req.body);
    const user = await tx(pool, async (db) => {
      // Never leave the deployment without an active administrator.
      if ((b.role === 'user' || b.isActive === false)) {
        const { rows } = await db.query(
          "SELECT id FROM users WHERE role = 'admin' AND is_active AND id <> $1 FOR UPDATE", [id],
        );
        const { rows: target } = await db.query("SELECT role FROM users WHERE id = $1", [id]);
        if (target[0] && target[0].role === 'admin' && rows.length === 0) throw conflict('LAST_ADMIN');
      }
      const { rows } = await db.query(
        `UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active)
          WHERE id = $1 RETURNING id, email, display_name, role, is_active, locale, created_at, last_login_at`,
        [id, b.role ?? null, b.isActive ?? null],
      );
      if (!rows[0]) throw notFound('USER_NOT_FOUND');
      if (b.isActive === false) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(db, { actorId: req.user.id, action: 'user.updated', entityType: 'user', entityId: id, details: b });
      return rows[0];
    });
    res.json({ user: toApi(user) });
  });

  // ---- AI coach settings ----
  r.get('/settings/llm', async (_req, res) => {
    res.json({ llm: publicView(await effectiveLlm(pool, config), config) });
  });

  r.put('/settings/llm', async (req, res) => {
    const b = parse(llmSchema, req.body);
    if (b.enabled && (!b.endpoint || !b.model)) {
      throw new HttpError(400, 'AI_SETTINGS_INCOMPLETE', 'Endpoint and model are required to enable the AI coach');
    }
    const llm = await saveLlm(pool, config, req.user.id, b);
    // Never log the key itself; only whether it changed.
    const { apiKey, ...rest } = b;
    await audit(pool, {
      actorId: req.user.id, action: 'settings.llm_updated', entityType: 'settings', entityId: 'llm',
      details: { ...rest, apiKey: apiKey === undefined ? 'unchanged' : apiKey === '' ? 'removed' : 'replaced' },
    });
    res.json({ llm: publicView(llm, config) });
  });

  r.delete('/settings/llm', async (req, res) => {
    await resetLlm(pool);
    await audit(pool, { actorId: req.user.id, action: 'settings.llm_reset', entityType: 'settings', entityId: 'llm' });
    res.json({ llm: publicView(await effectiveLlm(pool, config), config) });
  });

  // Sends a tiny prompt with the saved settings. Not counted in usage limits.
  r.post('/settings/llm/test', async (_req, res) => {
    const llm = await effectiveLlm(pool, config);
    if (!llmEnabled({ ...llm, enabled: true })) throw new HttpError(400, 'AI_SETTINGS_INCOMPLETE', 'Endpoint and model are required');
    const started = Date.now();
    const reply = await chat({ ...llm, enabled: true, timeoutMs: Math.min(llm.timeoutMs || 45000, 30000) },
      [{ role: 'user', content: 'Reply with the single word: OK' }], { temperature: 0, maxTokens: 10 });
    res.json({ ok: true, latencyMs: Date.now() - started, reply: reply.trim().slice(0, 200) });
  });

  r.get('/audit', async (req, res) => {
    const q = parse(z.object({
      hackathonId: uuid.optional(),
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    const { rows } = await pool.query(
      `SELECT a.*, u.display_name AS actor_name, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::uuid IS NULL OR a.hackathon_id = $1) AND ($2::bigint IS NULL OR a.id < $2)
        ORDER BY a.id DESC LIMIT $3`,
      [q.hackathonId || null, q.before || null, q.limit],
    );
    res.json({ entries: toApi(rows.map((row) => ({ ...row, id: String(row.id) }))) });
  });

  return r;
};
