'use strict';

const express = require('express');
const { z, parse, text, requiredText, uuid, idParam } = require('../../lib/http');
const { requireUser, requireAdmin } = require('../../auth/sessions');
const { toApi } = require('../../lib/shape');
const svc = require('./service');

const roundSchema = z.object({
  kind: z.enum(['screening', 'review', 'final']),
  nameEn: requiredText(160),
  nameAr: text(160).default(''),
  sourceRoundId: uuid.nullable().default(null),
  assignmentMode: z.enum(['all', 'assigned']).default('all'),
  minReviewers: z.number().int().min(1).max(50).default(2),
  advanceCount: z.number().int().min(0).max(10000).nullable().default(null),
  sortOrder: z.number().int().default(0),
  useTemplate: z.boolean().default(true),
});
const roundPatch = z.object({
  nameEn: requiredText(160), nameAr: text(160), sourceRoundId: uuid.nullable(),
  assignmentMode: z.enum(['all', 'assigned']), minReviewers: z.number().int().min(1).max(50),
  advanceCount: z.number().int().min(0).max(10000).nullable(), sortOrder: z.number().int(),
}).partial();
const criterionSchema = z.object({
  nameEn: requiredText(160),
  nameAr: text(160).default(''),
  descriptionEn: text(1000).default(''),
  descriptionAr: text(1000).default(''),
  weight: z.number().positive().max(1000),
  minScore: z.number().int().min(0).max(100).default(1),
  maxScore: z.number().int().min(1).max(100).default(5),
  sortOrder: z.number().int().default(0),
}).refine((c) => c.maxScore > c.minScore, { message: 'maxScore must be greater than minScore', path: ['maxScore'] });
const criterionPatch = z.object({
  nameEn: requiredText(160), nameAr: text(160), descriptionEn: text(1000), descriptionAr: text(1000),
  weight: z.number().positive().max(1000), minScore: z.number().int().min(0).max(100),
  maxScore: z.number().int().min(1).max(100), sortOrder: z.number().int(),
}).partial();
const evaluationSchema = z.object({
  scores: z.record(z.string(), z.number()).default({}),
  comment: text(4000).default(''),
  recommendation: z.enum(['advance', 'hold', 'reject']).nullable().default(null),
  submit: z.boolean().default(false),
  conflict: z.boolean().default(false),
  conflictReason: text(1000).default(''),
});

module.exports = function governanceRoutes({ pool }) {
  const r = express.Router();
  r.use(requireUser);

  // ---- administration ----
  r.get('/review-templates', requireAdmin, (_req, res) => res.json({ templates: svc.TEMPLATES }));

  r.post('/hackathons/:ref/rounds', requireAdmin, async (req, res) => {
    const round = await svc.createRound(pool, req.user, req.params.ref, parse(roundSchema, req.body));
    res.status(201).json({ round: toApi(round) });
  });
  r.patch('/rounds/:id', requireAdmin, async (req, res) => {
    res.json({ round: toApi(await svc.updateRound(pool, req.user, idParam(req), parse(roundPatch, req.body))) });
  });
  r.delete('/rounds/:id', requireAdmin, async (req, res) => {
    await svc.deleteRound(pool, req.user, idParam(req));
    res.status(204).end();
  });
  r.post('/rounds/:id/open', requireAdmin, async (req, res) => {
    res.json({ round: toApi(await svc.transition(pool, req.user, idParam(req), 'open')) });
  });
  r.post('/rounds/:id/close', requireAdmin, async (req, res) => {
    res.json({ round: toApi(await svc.transition(pool, req.user, idParam(req), 'close')) });
  });
  r.post('/rounds/:id/publish', requireAdmin, async (req, res) => {
    const b = parse(z.object({ published: z.boolean().default(true) }), req.body);
    res.json({ round: toApi(await svc.publishResults(pool, req.user, idParam(req), b.published)) });
  });
  r.post('/rounds/:id/criteria', requireAdmin, async (req, res) => {
    res.status(201).json({ criterion: toApi(await svc.addCriterion(pool, req.user, idParam(req), parse(criterionSchema, req.body))) });
  });
  r.patch('/criteria/:id', requireAdmin, async (req, res) => {
    res.json({ criterion: toApi(await svc.updateCriterion(pool, req.user, idParam(req), parse(criterionPatch, req.body))) });
  });
  r.delete('/criteria/:id', requireAdmin, async (req, res) => {
    await svc.deleteCriterion(pool, req.user, idParam(req));
    res.status(204).end();
  });
  r.post('/rounds/:id/reviewers', requireAdmin, async (req, res) => {
    const b = parse(z.object({
      userId: uuid.optional(), email: z.string().trim().email().optional(), isChair: z.boolean().default(false),
    }).refine((v) => v.userId || v.email, { message: 'userId or email is required' }), req.body);
    res.status(201).json({ reviewer: await svc.addReviewer(pool, req.user, idParam(req), b) });
  });
  r.delete('/rounds/:id/reviewers/:userId', requireAdmin, async (req, res) => {
    await svc.removeReviewer(pool, req.user, idParam(req), idParam(req, 'userId'));
    res.status(204).end();
  });
  r.put('/rounds/:id/assignments/:ideaId', requireAdmin, async (req, res) => {
    const b = parse(z.object({ reviewerIds: z.array(uuid).max(50) }), req.body);
    await svc.setAssignments(pool, req.user, idParam(req), idParam(req, 'ideaId'), b.reviewerIds);
    res.status(204).end();
  });

  // ---- reading (admins and committee members) ----
  r.get('/hackathons/:ref/rounds', async (req, res) => {
    res.json({ rounds: toApi(await svc.listRounds(pool, req.user, req.params.ref)) });
  });
  r.get('/rounds/:id', async (req, res) => {
    const d = await svc.getRound(pool, req.user, idParam(req));
    res.json({ round: toApi(d.round), criteria: toApi(d.criteria), reviewers: toApi(d.reviewers), access: d.access });
  });

  // ---- reviewers ----
  r.get('/rounds/:id/my-candidates', async (req, res) => {
    res.json({ candidates: toApi(await svc.myCandidates(pool, req.user, idParam(req))) });
  });
  r.get('/rounds/:id/candidates/:ideaId', async (req, res) => {
    const d = await svc.candidateDetail(pool, req.user, idParam(req), idParam(req, 'ideaId'));
    res.json({
      round: toApi(d.round), idea: toApi(d.idea), members: toApi(d.members), criteria: toApi(d.criteria),
      evaluation: toApi(d.evaluation), autoConflict: d.autoConflict,
    });
  });
  r.put('/rounds/:id/candidates/:ideaId/evaluation', async (req, res) => {
    const b = parse(evaluationSchema, req.body);
    res.json({ evaluation: toApi(await svc.saveEvaluation(pool, req.user, idParam(req), idParam(req, 'ideaId'), b)) });
  });

  // ---- chair and admins ----
  r.get('/rounds/:id/board', async (req, res) => {
    const d = await svc.board(pool, req.user, idParam(req));
    res.json({
      round: toApi(d.round),
      rows: d.rows.map((row) => ({
        ideaId: row.id, idea: toApi(row.idea), aggregate: row.aggregate, rank: row.rank,
        suggestion: row.suggestion, decision: toApi(row.decision),
      })),
    });
  });
  r.get('/rounds/:id/candidates/:ideaId/evaluations', async (req, res) => {
    const d = await svc.candidateEvaluations(pool, req.user, idParam(req), idParam(req, 'ideaId'));
    res.json({ criteria: toApi(d.criteria), evaluations: toApi(d.evaluations) });
  });
  r.put('/rounds/:id/decisions/:ideaId', async (req, res) => {
    const b = parse(z.object({ outcome: z.enum(['advance', 'waitlist', 'reject']), note: text(2000).default('') }), req.body);
    res.json({ decision: await svc.decide(pool, req.user, idParam(req), idParam(req, 'ideaId'), b) });
  });
  r.post('/rounds/:id/finalize', async (req, res) => {
    const b = parse(z.object({ applySuggestions: z.boolean().default(false) }), req.body);
    res.json({ round: toApi(await svc.finalize(pool, req.user, idParam(req), b)) });
  });

  // ---- participants ----
  r.get('/hackathons/:ref/results', async (req, res) => {
    const rounds = await svc.results(pool, req.user, req.params.ref);
    res.json({ rounds: rounds.map((x) => ({ ...toApi(x), advanced: toApi(x.advanced) })) });
  });

  return r;
};
