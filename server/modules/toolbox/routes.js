'use strict';

const express = require('express');
const { z, parse, text, requiredText, idParam } = require('../../lib/http');
const { requireUser, requireAdmin } = require('../../auth/sessions');
const { notFound } = require('../../lib/errors');
const { rateLimit } = require('../../lib/security');
const { audit } = require('../../lib/audit');
const { toApi } = require('../../lib/shape');
const { loadHackathon } = require('../hackathons/service');
const svc = require('./service');

const httpUrl = z.string().trim().max(1000).regex(/^https?:\/\//i, 'Must start with http:// or https://');

const resourceSchema = z.object({
  category: z.enum(['guide', 'template', 'tool', 'video', 'data', 'other']).default('guide'),
  titleEn: requiredText(200),
  titleAr: text(200).default(''),
  descriptionEn: text(2000).default(''),
  descriptionAr: text(2000).default(''),
  url: z.string().trim().max(1000).regex(/^(https?:\/\/|\/)/i, 'Must be an http(s) URL or a site path'),
  sortOrder: z.number().int().default(0),
  global: z.boolean().default(false),
});

module.exports = function toolboxRoutes({ pool, config }) {
  const r = express.Router();
  r.use(requireUser);

  // ---- progress wall ----
  r.get('/hackathons/:ref/progress', async (req, res) => {
    const q = parse(z.object({
      teamId: z.string().uuid().optional(),
      kind: z.enum(['update', 'blocker', 'demo', 'help']).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }), req.query);
    res.json({ posts: toApi(await svc.feed(pool, req.user, req.params.ref, q)) });
  });
  r.post('/teams/:id/progress', async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(['update', 'blocker', 'demo', 'help']).default('update'),
      body: requiredText(2000),
      linkUrl: z.union([httpUrl, z.literal('')]).default(''),
      visibility: z.enum(['public', 'team']).default('public'),
    }), req.body);
    res.status(201).json({ post: toApi(await svc.createPost(pool, req.user, idParam(req), b)) });
  });
  r.get('/progress/:id/replies', async (req, res) => {
    res.json({ replies: toApi(await svc.replies(pool, req.user, idParam(req))) });
  });
  r.post('/progress/:id/replies', async (req, res) => {
    const b = parse(z.object({ body: requiredText(2000) }), req.body);
    res.status(201).json({ reply: toApi(await svc.reply(pool, req.user, idParam(req), b.body)) });
  });
  r.post('/progress/:id/resolve', async (req, res) => {
    const b = parse(z.object({ resolved: z.boolean().default(true) }), req.body);
    res.json({ post: toApi(await svc.setResolved(pool, req.user, idParam(req), b.resolved)) });
  });
  r.delete('/progress/:id', async (req, res) => {
    await svc.deletePost(pool, req.user, idParam(req));
    res.status(204).end();
  });
  r.get('/hackathons/:ref/pulse', async (req, res) => {
    const d = await svc.pulse(pool, req.user, req.params.ref);
    res.json({ teams: toApi(d.teams), daily: toApi(d.daily) });
  });

  // ---- resources ----
  r.get('/hackathons/:ref/resources', async (req, res) => {
    res.json({ resources: toApi(await svc.listResources(pool, req.user, req.params.ref)) });
  });
  r.post('/hackathons/:ref/resources', requireAdmin, async (req, res) => {
    const b = parse(resourceSchema, req.body);
    const h = await loadHackathon(pool, req.params.ref, req.user);
    const { rows } = await pool.query(
      `INSERT INTO resources (hackathon_id, category, title_en, title_ar, description_en, description_ar, url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [b.global ? null : h.id, b.category, b.titleEn, b.titleAr, b.descriptionEn, b.descriptionAr, b.url, b.sortOrder],
    );
    await audit(pool, { actorId: req.user.id, hackathonId: h.id, action: 'resource.created', entityType: 'resource', entityId: rows[0].id });
    res.status(201).json({ resource: toApi(rows[0]) });
  });
  r.delete('/resources/:id', requireAdmin, async (req, res) => {
    const { rows } = await pool.query('DELETE FROM resources WHERE id = $1 RETURNING hackathon_id', [idParam(req)]);
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'resource.deleted', entityType: 'resource', entityId: req.params.id });
    res.status(204).end();
  });

  // ---- AI coach ----
  const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, key: (req) => req.user.id });
  r.post('/hackathons/:ref/coach', aiLimiter, async (req, res) => {
    const b = parse(z.object({
      mode: z.enum(Object.keys(svc.MODES)),
      text: z.string().trim().min(40, 'Write at least a few sentences').max(8000),
      locale: z.enum(['en', 'ar']).default('en'),
    }), req.body);
    res.json(await svc.coach(pool, config, req.user, req.params.ref, b));
  });

  return r;
};
