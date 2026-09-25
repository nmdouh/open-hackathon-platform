'use strict';

const express = require('express');
const { z, parse, text, requiredText, isoDate, idParam } = require('../../lib/http');
const { notFound, badRequest, fromPg } = require('../../lib/errors');
const { requireAdmin, isAdmin } = require('../../auth/sessions');
const { audit } = require('../../lib/audit');
const { toApi } = require('../../lib/shape');
const { tx } = require('../../db/pool');
const { loadHackathon, registrationOpen, ideaSubmissionOpen, teamingOpen } = require('./service');

const STATUSES = ['draft', 'open', 'running', 'closed', 'archived'];

const hackathonFields = {
  title_en: requiredText(200),
  title_ar: text(200),
  summary_en: text(4000),
  summary_ar: text(4000),
  status: z.enum(STATUSES),
  registration_opens_at: isoDate,
  registration_closes_at: isoDate,
  idea_submission_closes_at: isoDate,
  min_team_size: z.number().int().min(1).max(50),
  max_team_size: z.number().int().min(1).max(50),
  max_pending_applications: z.number().int().min(1).max(20),
};
// API field names are camelCase; map them to columns explicitly.
const FIELD_MAP = {
  titleEn: 'title_en', titleAr: 'title_ar', summaryEn: 'summary_en', summaryAr: 'summary_ar', status: 'status',
  registrationOpensAt: 'registration_opens_at', registrationClosesAt: 'registration_closes_at',
  ideaSubmissionClosesAt: 'idea_submission_closes_at', minTeamSize: 'min_team_size',
  maxTeamSize: 'max_team_size', maxPendingApplications: 'max_pending_applications',
};
const hackathonSchema = z.object(Object.fromEntries(
  Object.entries(FIELD_MAP).map(([api, col]) => [api, hackathonFields[col]]),
));

const trackSchema = z.object({
  nameEn: requiredText(120), nameAr: text(120).default(''),
  descriptionEn: text(2000).default(''), descriptionAr: text(2000).default(''),
  sortOrder: z.number().int().default(0),
});
const stageSchema = z.object({
  nameEn: requiredText(120), nameAr: text(120).default(''),
  startsAt: isoDate.default(null), endsAt: isoDate.default(null), sortOrder: z.number().int().default(0),
});
const announcementSchema = z.object({
  titleEn: requiredText(200), titleAr: text(200).default(''),
  bodyEn: text(8000).default(''), bodyAr: text(8000).default(''), pinned: z.boolean().default(false),
});

function withFlags(h) {
  return {
    ...toApi(h),
    registrationOpen: registrationOpen(h),
    ideaSubmissionOpen: ideaSubmissionOpen(h),
    teamingOpen: teamingOpen(h),
  };
}

// Builds "col = $n" pairs for a partial update from a camelCase body.
function updateSet(body, map, startAt = 2) {
  const cols = [];
  const vals = [];
  for (const [api, col] of Object.entries(map)) {
    if (body[api] === undefined) continue;
    vals.push(body[api]);
    cols.push(`${col} = $${startAt + vals.length - 1}`);
  }
  return { cols, vals };
}

module.exports = function hackathonRoutes({ pool }) {
  const r = express.Router();

  r.get('/hackathons', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM hackathons ${isAdmin(req.user) ? '' : "WHERE status <> 'draft'"}
       ORDER BY (status IN ('open', 'running')) DESC, created_at DESC`,
    );
    res.json({ hackathons: rows.map(withFlags) });
  });

  r.post('/hackathons', requireAdmin, async (req, res) => {
    const body = parse(hackathonSchema.partial().required({ titleEn: true }).extend({
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    }), req.body);
    if (body.minTeamSize && body.maxTeamSize && body.minTeamSize > body.maxTeamSize) {
      throw badRequest('TEAM_SIZE_RANGE', 'Minimum team size exceeds maximum');
    }
    const created = await tx(pool, async (db) => {
      const cols = ['slug', 'created_by'];
      const vals = [body.slug, req.user.id];
      for (const [api, col] of Object.entries(FIELD_MAP)) {
        if (body[api] !== undefined) { cols.push(col); vals.push(body[api]); }
      }
      const { rows } = await db.query(
        `INSERT INTO hackathons (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        vals,
      ).catch((e) => { throw fromPg(e); });
      await audit(db, { actorId: req.user.id, hackathonId: rows[0].id, action: 'hackathon.created', entityType: 'hackathon', entityId: rows[0].id });
      return rows[0];
    });
    res.status(201).json({ hackathon: withFlags(created) });
  });

  r.get('/hackathons/:ref', async (req, res) => {
    const h = await loadHackathon(pool, req.params.ref, req.user);
    const [tracks, stages] = await Promise.all([
      pool.query('SELECT * FROM tracks WHERE hackathon_id = $1 ORDER BY sort_order, name_en', [h.id]),
      pool.query('SELECT * FROM stages WHERE hackathon_id = $1 ORDER BY sort_order, starts_at NULLS LAST', [h.id]),
    ]);
    res.json({ hackathon: withFlags(h), tracks: toApi(tracks.rows), stages: toApi(stages.rows) });
  });

  r.patch('/hackathons/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const body = parse(hackathonSchema.partial(), req.body);
    const updated = await tx(pool, async (db) => {
      const before = await loadHackathon(db, id, req.user, { lock: true });
      const { cols, vals } = updateSet(body, FIELD_MAP);
      if (!cols.length) return before;
      const { rows } = await db.query(
        `UPDATE hackathons SET ${cols.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...vals],
      ).catch((e) => { throw fromPg(e); });
      await audit(db, {
        actorId: req.user.id, hackathonId: id, action: 'hackathon.updated', entityType: 'hackathon', entityId: id,
        details: { fields: Object.keys(body), statusFrom: before.status, statusTo: rows[0].status },
      });
      return rows[0];
    });
    res.json({ hackathon: withFlags(updated) });
  });

  // ---- tracks ----
  r.post('/hackathons/:id/tracks', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const b = parse(trackSchema, req.body);
    await loadHackathon(pool, id, req.user);
    const { rows } = await pool.query(
      `INSERT INTO tracks (hackathon_id, name_en, name_ar, description_en, description_ar, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, b.nameEn, b.nameAr, b.descriptionEn, b.descriptionAr, b.sortOrder],
    );
    await audit(pool, { actorId: req.user.id, hackathonId: id, action: 'track.created', entityType: 'track', entityId: rows[0].id });
    res.status(201).json({ track: toApi(rows[0]) });
  });

  r.patch('/tracks/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const b = parse(trackSchema.partial(), req.body);
    const { cols, vals } = updateSet(b, {
      nameEn: 'name_en', nameAr: 'name_ar', descriptionEn: 'description_en', descriptionAr: 'description_ar', sortOrder: 'sort_order',
    });
    if (!cols.length) throw badRequest('NOTHING_TO_UPDATE');
    const { rows } = await pool.query(`UPDATE tracks SET ${cols.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'track.updated', entityType: 'track', entityId: id });
    res.json({ track: toApi(rows[0]) });
  });

  r.delete('/tracks/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const { rows } = await pool.query('DELETE FROM tracks WHERE id = $1 RETURNING hackathon_id', [id]);
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'track.deleted', entityType: 'track', entityId: id });
    res.status(204).end();
  });

  // ---- stages (public timeline) ----
  r.post('/hackathons/:id/stages', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const b = parse(stageSchema, req.body);
    await loadHackathon(pool, id, req.user);
    const { rows } = await pool.query(
      `INSERT INTO stages (hackathon_id, name_en, name_ar, starts_at, ends_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, b.nameEn, b.nameAr, b.startsAt, b.endsAt, b.sortOrder],
    ).catch((e) => { throw fromPg(e); });
    await audit(pool, { actorId: req.user.id, hackathonId: id, action: 'stage.created', entityType: 'stage', entityId: rows[0].id });
    res.status(201).json({ stage: toApi(rows[0]) });
  });

  r.patch('/stages/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const b = parse(stageSchema.partial(), req.body);
    const { cols, vals } = updateSet(b, {
      nameEn: 'name_en', nameAr: 'name_ar', startsAt: 'starts_at', endsAt: 'ends_at', sortOrder: 'sort_order',
    });
    if (!cols.length) throw badRequest('NOTHING_TO_UPDATE');
    const { rows } = await pool.query(`UPDATE stages SET ${cols.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals])
      .catch((e) => { throw fromPg(e); });
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'stage.updated', entityType: 'stage', entityId: id });
    res.json({ stage: toApi(rows[0]) });
  });

  r.delete('/stages/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const { rows } = await pool.query('DELETE FROM stages WHERE id = $1 RETURNING hackathon_id', [id]);
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'stage.deleted', entityType: 'stage', entityId: id });
    res.status(204).end();
  });

  // ---- announcements ----
  r.get('/hackathons/:id/announcements', async (req, res) => {
    const h = await loadHackathon(pool, idParam(req), req.user);
    const { rows } = await pool.query(
      'SELECT * FROM announcements WHERE hackathon_id = $1 ORDER BY pinned DESC, created_at DESC LIMIT 100',
      [h.id],
    );
    res.json({ announcements: toApi(rows) });
  });

  r.post('/hackathons/:id/announcements', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const b = parse(announcementSchema, req.body);
    await loadHackathon(pool, id, req.user);
    const { rows } = await pool.query(
      `INSERT INTO announcements (hackathon_id, title_en, title_ar, body_en, body_ar, pinned, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, b.titleEn, b.titleAr, b.bodyEn, b.bodyAr, b.pinned, req.user.id],
    );
    await audit(pool, { actorId: req.user.id, hackathonId: id, action: 'announcement.created', entityType: 'announcement', entityId: rows[0].id });
    res.status(201).json({ announcement: toApi(rows[0]) });
  });

  r.delete('/announcements/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const { rows } = await pool.query('DELETE FROM announcements WHERE id = $1 RETURNING hackathon_id', [id]);
    if (!rows[0]) throw notFound();
    await audit(pool, { actorId: req.user.id, hackathonId: rows[0].hackathon_id, action: 'announcement.deleted', entityType: 'announcement', entityId: id });
    res.status(204).end();
  });

  return r;
};
