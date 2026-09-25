'use strict';

const express = require('express');
const { z, parse, text, requiredText, uuid, isoDate, idParam } = require('../../lib/http');
const { requireUser, requireAdmin } = require('../../auth/sessions');
const { toApi } = require('../../lib/shape');
const svc = require('./service');

module.exports = function mentoringRoutes({ pool }) {
  const r = express.Router();
  r.use(requireUser);

  r.get('/hackathons/:ref/mentors', async (req, res) => {
    res.json({ mentors: toApi(await svc.listMentors(pool, req.user, req.params.ref)) });
  });
  r.post('/hackathons/:ref/mentors', requireAdmin, async (req, res) => {
    const b = parse(z.object({
      userId: uuid.optional(), email: z.string().trim().email().optional(),
      expertise: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      bio: text(2000).default(''), maxTeams: z.number().int().min(1).max(50).default(5),
    }).refine((v) => v.userId || v.email, { message: 'userId or email is required' }), req.body);
    res.status(201).json({ mentor: toApi(await svc.addMentor(pool, req.user, req.params.ref, b)) });
  });
  r.delete('/hackathons/:ref/mentors/:userId', requireAdmin, async (req, res) => {
    await svc.removeMentor(pool, req.user, req.params.ref, idParam(req, 'userId'));
    res.status(204).end();
  });
  r.get('/hackathons/:ref/mentoring/me', async (req, res) => {
    res.json(toApi(await svc.myMentoring(pool, req.user, req.params.ref)));
  });
  r.get('/hackathons/:ref/mentoring/requests', async (req, res) => {
    const q = parse(z.object({ teamId: uuid.optional() }), req.query);
    res.json({ requests: toApi(await svc.listRequests(pool, req.user, req.params.ref, q)) });
  });

  r.get('/teams/:id/mentors', async (req, res) => {
    res.json({ mentors: toApi(await svc.teamMentors(pool, req.user, idParam(req))) });
  });
  r.put('/teams/:id/mentors/:userId', requireAdmin, async (req, res) => {
    await svc.assignMentor(pool, req.user, idParam(req), idParam(req, 'userId'));
    res.status(204).end();
  });
  r.delete('/teams/:id/mentors/:userId', requireAdmin, async (req, res) => {
    await svc.unassignMentor(pool, req.user, idParam(req), idParam(req, 'userId'));
    res.status(204).end();
  });

  r.post('/teams/:id/mentoring-requests', async (req, res) => {
    const b = parse(z.object({
      topic: requiredText(200), details: text(4000).default(''), mentorId: uuid.nullable().default(null),
    }), req.body);
    res.status(201).json({ request: toApi(await svc.createRequest(pool, req.user, idParam(req), b)) });
  });
  r.post('/mentoring-requests/:id/accept', async (req, res) => {
    const b = parse(z.object({ scheduledAt: isoDate.default(null) }), req.body);
    res.json({ request: toApi(await svc.mentorAction(pool, req.user, idParam(req), 'accept', b)) });
  });
  r.post('/mentoring-requests/:id/decline', async (req, res) => {
    res.json({ request: toApi(await svc.mentorAction(pool, req.user, idParam(req), 'decline')) });
  });
  r.post('/mentoring-requests/:id/complete', async (req, res) => {
    const b = parse(z.object({ notes: text(4000).default('') }), req.body);
    res.json({ request: toApi(await svc.mentorAction(pool, req.user, idParam(req), 'complete', b)) });
  });
  r.post('/mentoring-requests/:id/cancel', async (req, res) => {
    await svc.cancelRequest(pool, req.user, idParam(req));
    res.status(204).end();
  });

  return r;
};
