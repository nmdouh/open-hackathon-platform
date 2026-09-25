'use strict';

const express = require('express');
const { z, parse, text, requiredText, isoDate, idParam } = require('../../lib/http');
const { requireUser, requireAdmin } = require('../../auth/sessions');
const { toApi } = require('../../lib/shape');
const svc = require('./service');

const milestoneSchema = z.object({
  titleEn: requiredText(200), titleAr: text(200).default(''),
  descriptionEn: text(2000).default(''), descriptionAr: text(2000).default(''),
  dueAt: isoDate.default(null), sortOrder: z.number().int().default(0),
});

module.exports = function engagementRoutes({ pool }) {
  const r = express.Router();

  // Headline numbers are public for published hackathons.
  r.get('/hackathons/:ref/stats', async (req, res) => {
    res.json({ stats: toApi(await svc.stats(pool, req.user, req.params.ref)) });
  });
  r.get('/hackathons/:ref/milestones', async (req, res) => {
    res.json({ milestones: toApi(await svc.listMilestones(pool, req.user, req.params.ref)) });
  });

  r.use(requireUser);

  // ---- notifications ----
  r.get('/notifications', async (req, res) => {
    const q = parse(z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      unread: z.enum(['1', 'true']).optional(),
    }), req.query);
    const [items, unread] = await Promise.all([
      svc.listNotifications(pool, req.user, { limit: q.limit, unreadOnly: Boolean(q.unread) }),
      svc.unreadCount(pool, req.user),
    ]);
    res.json({ notifications: toApi(items.map((n) => ({ ...n, id: String(n.id) }))), unread });
  });
  r.get('/notifications/unread', async (req, res) => {
    res.json({ unread: await svc.unreadCount(pool, req.user) });
  });
  r.post('/notifications/read', async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string().regex(/^\d+$/)).max(200).optional(), all: z.boolean().default(false) }), req.body);
    res.json({ unread: await svc.markRead(pool, req.user, b) });
  });

  // ---- matchmaking ----
  r.get('/hackathons/:ref/matches', async (req, res) => {
    res.json(toApi(await svc.matches(pool, req.user, req.params.ref)));
  });

  // ---- milestones ----
  r.post('/hackathons/:ref/milestones', requireAdmin, async (req, res) => {
    res.status(201).json({ milestone: toApi(await svc.createMilestone(pool, req.user, req.params.ref, parse(milestoneSchema, req.body))) });
  });
  r.post('/hackathons/:ref/milestones/template', requireAdmin, async (req, res) => {
    await svc.applyMilestoneTemplate(pool, req.user, req.params.ref);
    res.status(201).json({ milestones: toApi(await svc.listMilestones(pool, req.user, req.params.ref)) });
  });
  r.patch('/milestones/:id', requireAdmin, async (req, res) => {
    res.json({ milestone: toApi(await svc.updateMilestone(pool, req.user, idParam(req), parse(milestoneSchema.partial(), req.body))) });
  });
  r.delete('/milestones/:id', requireAdmin, async (req, res) => {
    await svc.deleteMilestone(pool, req.user, idParam(req));
    res.status(204).end();
  });
  r.get('/teams/:id/milestones', async (req, res) => {
    const d = await svc.teamMilestones(pool, req.user, idParam(req));
    res.json({ milestones: toApi(d.milestones), canEdit: d.canEdit });
  });
  r.put('/teams/:id/milestones/:milestoneId', async (req, res) => {
    const b = parse(z.object({
      done: z.boolean(),
      evidenceUrl: z.union([z.string().trim().max(1000).regex(/^https?:\/\//i, 'Must start with http:// or https://'), z.literal('')]).default(''),
    }), req.body);
    await svc.setTeamMilestone(pool, req.user, idParam(req), idParam(req, 'milestoneId'), b);
    res.status(204).end();
  });

  // ---- organiser dashboard ----
  r.get('/hackathons/:ref/dashboard', requireAdmin, async (req, res) => {
    const d = await svc.dashboard(pool, req.user, req.params.ref);
    res.json({
      funnel: toApi(d.funnel), tracks: toApi(d.tracks), rounds: toApi(d.rounds), mentoring: d.mentoring,
      activity: toApi(d.activity), teams: toApi(d.teams), atRisk: toApi(d.atRisk),
      milestonesTotal: d.milestonesTotal, minTeamSize: d.minTeamSize,
    });
  });

  return r;
};
