'use strict';

const express = require('express');
const { z, parse, text, requiredText, uuid, idParam } = require('../../lib/http');
const { requireUser, requireAdmin } = require('../../auth/sessions');
const { toApi } = require('../../lib/shape');
const svc = require('./service');

const skills = z.array(z.string().trim().min(1).max(60)).max(20);
const role = z.enum(['idea_owner', 'member']);

const ideaFields = {
  title: requiredText(200),
  problem: text(6000),
  solution: text(6000),
  targetUsers: text(3000),
  expectedImpact: text(3000),
  dataAndTools: text(3000),
  trackId: uuid.nullable(),
};

module.exports = function participationRoutes({ pool }) {
  const r = express.Router();
  r.use(requireUser);

  // ---- registration ----
  r.get('/hackathons/:ref/me', async (req, res) => {
    const s = await svc.myState(pool, req.user, req.params.ref);
    res.json({
      registration: toApi(s.registration),
      idea: toApi(s.idea),
      membership: toApi(s.membership),
      applications: toApi(s.applications),
    });
  });

  r.post('/hackathons/:ref/registration', async (req, res) => {
    const b = parse(z.object({ role, skills: skills.default([]), bio: text(2000).default('') }), req.body);
    const reg = await svc.register(pool, req.user, req.params.ref, b);
    res.status(201).json({ registration: toApi(reg) });
  });

  r.patch('/hackathons/:ref/registration', async (req, res) => {
    const b = parse(z.object({ role: role.optional(), skills: skills.optional(), bio: text(2000).optional() }), req.body);
    const reg = await svc.updateRegistration(pool, req.user, req.params.ref, b);
    res.json({ registration: toApi(reg) });
  });

  r.delete('/hackathons/:ref/registration', async (req, res) => {
    await svc.withdrawRegistration(pool, req.user, req.params.ref);
    res.status(204).end();
  });

  r.get('/hackathons/:ref/participants', requireAdmin, async (req, res) => {
    res.json({ participants: toApi(await svc.participants(pool, req.user, req.params.ref)) });
  });

  // ---- ideas ----
  r.get('/hackathons/:ref/ideas', async (req, res) => {
    res.json({ ideas: toApi(await svc.listIdeas(pool, req.user, req.params.ref)) });
  });

  r.post('/hackathons/:ref/ideas', async (req, res) => {
    const b = parse(z.object({ ...ideaFields, submit: z.boolean().default(false) }).partial().required({ title: true }), req.body);
    const idea = await svc.createIdea(pool, req.user, req.params.ref, b, { submit: Boolean(b.submit) });
    res.status(201).json({ idea: toApi(idea) });
  });

  r.get('/ideas/:id', async (req, res) => {
    res.json({ idea: toApi(await svc.getIdea(pool, req.user, idParam(req))) });
  });

  r.patch('/ideas/:id', async (req, res) => {
    const b = parse(z.object(ideaFields).partial(), req.body);
    res.json({ idea: toApi(await svc.updateIdea(pool, req.user, idParam(req), b)) });
  });

  r.post('/ideas/:id/submit', async (req, res) => {
    res.json({ idea: toApi(await svc.submitIdea(pool, req.user, idParam(req))) });
  });

  r.post('/ideas/:id/withdraw', async (req, res) => {
    res.json({ idea: toApi(await svc.withdrawIdea(pool, req.user, idParam(req))) });
  });

  // ---- teams ----
  r.post('/ideas/:id/team', async (req, res) => {
    const b = parse(z.object({ name: requiredText(120), lookingFor: text(2000).default('') }), req.body);
    const team = await svc.createTeam(pool, req.user, idParam(req), b);
    res.status(201).json({ team: toApi(team) });
  });

  r.get('/hackathons/:ref/teams', async (req, res) => {
    res.json({ teams: toApi(await svc.listTeams(pool, req.user, req.params.ref)) });
  });

  r.get('/teams/:id', async (req, res) => {
    const t = await svc.getTeam(pool, req.user, idParam(req));
    res.json({ team: toApi(t.team), members: toApi(t.members), insider: t.insider });
  });

  r.patch('/teams/:id', async (req, res) => {
    const b = parse(z.object({
      name: requiredText(120).optional(), lookingFor: text(2000).optional(), isOpen: z.boolean().optional(),
    }), req.body);
    res.json({ team: toApi(await svc.updateTeam(pool, req.user, idParam(req), b)) });
  });

  r.delete('/teams/:id', async (req, res) => {
    await svc.disbandTeam(pool, req.user, idParam(req));
    res.status(204).end();
  });

  r.delete('/teams/:id/members/:userId', async (req, res) => {
    await svc.removeMember(pool, req.user, idParam(req), idParam(req, 'userId'));
    res.status(204).end();
  });

  // ---- applications ----
  r.get('/teams/:id/applications', async (req, res) => {
    res.json({ applications: toApi(await svc.teamApplications(pool, req.user, idParam(req))) });
  });

  r.post('/teams/:id/applications', async (req, res) => {
    const b = parse(z.object({ message: text(2000).default('') }), req.body);
    res.status(201).json({ application: toApi(await svc.apply(pool, req.user, idParam(req), b)) });
  });

  r.post('/applications/:id/accept', async (req, res) => {
    res.json({ application: toApi(await svc.decide(pool, req.user, idParam(req), 'accepted')) });
  });

  r.post('/applications/:id/reject', async (req, res) => {
    res.json({ application: toApi(await svc.decide(pool, req.user, idParam(req), 'rejected')) });
  });

  r.post('/applications/:id/withdraw', async (req, res) => {
    res.json({ application: toApi(await svc.withdrawApplication(pool, req.user, idParam(req))) });
  });

  return r;
};
